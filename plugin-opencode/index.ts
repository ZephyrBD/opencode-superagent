import { Plugin } from '@opencode/plugin'
import { z } from 'zod'
import { Engine } from './core/engine.ts'
import { Executor, type SessionPort, type WorktreePort } from './core/executor.ts'
import { LlmAssessor, type GeneratePort } from './core/assessor.ts'
import { Outbox } from './core/outbox.ts'
import type { KV } from './core/kv.ts'
import { ReportSchema, type Ticket } from './core/model.ts'
import { GitHubSource } from './sources/github/index.ts'
import { startPanel } from './panel/http.ts'
import type { Assignment } from './core/assignment.ts'

export interface ToolContext {
  sessionID?: string
}

export interface ToolDefinition {
  name: string
  description: string
  execute: (input: unknown, context?: ToolContext) => Promise<unknown>
}

export interface ToolEditor {
  namespace(ns: { name: string; description: string }): void
  add(tool: ToolDefinition): void
  update(id: string, update: (tool: ToolDefinition) => void): void
  remove(id: string): void
}

export interface AssembleDeps {
  kv: KV
  sessions: SessionPort
  worktrees: WorktreePort
  token: string
  tools: ToolEditor
  generate?: GeneratePort
  poll?: () => Promise<unknown>
  recover?: () => Promise<void>
  resumeDispatch?: () => Promise<void>
  setIntervalFn?: (fn: () => void, ms: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
  panel?: { port?: number }
  /** Policy overrides: repository and allowed actors are the operator's decision. */
  config?: { repository?: string; allowedActors?: string[]; policyVersion?: string }
}

export interface AssembledApp {
  engine: Engine
  executor: Executor
  outbox: Outbox
  start(): Promise<void>
  cleanup(): Promise<void>
}

const ReportInputSchema = z.object({
  ticket: z.string().min(1),
  kind: ReportSchema.shape.kind,
  text: z.string(),
}).strict()

/** Wires the domain objects and the OpenCode-side layer together. Pure: tests drive it with fakes. */
export const assemble = (deps: AssembleDeps): AssembledApp => {
  const outbox = new Outbox({
    kv: deps.kv,
    clock: () => Date.now(),
    delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
    send: async (kind, payload) => {
      const { ticketId, inputs } = payload as { ticketId: string; inputs: string[] }
      const ticket = await deps.kv.get<Ticket>(`ticket/${ticketId}`)
      if (!ticket) return
      if (kind === 'dispatch') {
        // A replayed dispatch never reopens an ended ticket.
        if (ticket.status !== 'open') return
        await executor.dispatch(ticket, inputs)
      }
      if (kind === 'deliver') {
        if (ticket.status !== 'open') return
        await executor.deliver(ticketId, inputs.join('\n'))
      }
    },
  })

  const executor = new Executor({ sessions: deps.sessions, worktrees: deps.worktrees, kv: deps.kv, limit: 3 })
  const assessor = new LlmAssessor({ generate: deps.generate ?? { text: async () => ({ text: '{"kind":"unavailable"}' }) } })
  const engine = new Engine({
    kv: deps.kv,
    policy: {
      policyVersion: deps.config?.policyVersion ?? 'v1',
      paused: false,
      proactive: 'record',
      github: {
        repository: deps.config?.repository ?? 'owner/repo',
        allowedActors: deps.config?.allowedActors ?? [],
        pollSeconds: 60,
        agentLogin: 'agent-bot',
      },
    },
    assessor,
    clock: () => Date.now(),
    notify: event => {
      if (event.type === 'fanout') {
        void outbox.enqueue('deliver', { ticketId: event.ticketId, inputs: [event.trigger.text] }).catch(() => {})
      }
    },
  })
  // A person's message releases a held ticket and its text reaches the worker through the outbox,
  // so a failed delivery is retried instead of lost.
  engine.onPersonMessage = (ticketId, text) => {
    executor.onPersonMessage(ticketId)
    void outbox.enqueue('deliver', { ticketId, inputs: [text] }).catch(() => {})
  }

  deps.tools.add({
    name: 'superagent_report_ticket',
    description: 'Report the structured state of your ticket: progress, waiting, ready, blocked, failed or dropped.',
    execute: async (rawInput, context) => {
      const input = ReportInputSchema.parse(rawInput)
      const ticket = await deps.kv.get<Ticket>(`ticket/${input.ticket}`)
      if (!ticket) throw new Error(`unknown ticket ${input.ticket}`)
      // Only the ticket's own worker may report on it.
      if (ticket.sessionId && context?.sessionID && context.sessionID !== ticket.sessionId) {
        throw new Error(`session ${context.sessionID} is not this ticket's worker`)
      }
      await executor.report(input.ticket, { kind: input.kind, text: input.text, at: Date.now() })
      return { content: `reported ${input.kind}` }
    },
  })

  let handle: unknown
  let timerSet = false
  const closePanel = { close: async () => {} }
  return {
    engine,
    executor,
    outbox,
    async start() {
      // Recover stored work first: a reload or crash must replay it before anything new launches.
      if (deps.recover) await deps.recover()
      else await outbox.recover()
      await executor.rebuild()
      // A restart ends running assignments; each open ticket starts again, oldest first, with a recovery note.
      const tickets = (await deps.kv.scan('ticket/')).map(row => row.value as Ticket)
      const runningIds = new Set(
        (await deps.kv.scan('assignment/'))
          .map(row => row.value as Assignment)
          .filter(assignment => assignment.status === 'running')
          .map(assignment => assignment.ticketId),
      )
      const toRecover = tickets
        .filter(ticket => ticket.status === 'open' && runningIds.has(ticket.id))
        .sort((a, b) => a.id.localeCompare(b.id))
      for (const ticket of toRecover) await executor.recoverTicket(ticket)
      if (deps.resumeDispatch) await deps.resumeDispatch()
      for (const key of await engine.pendingThreads()) await engine.retryPending(key)
      if (deps.panel) {
        const panel = await startPanel({ kv: deps.kv }, { port: deps.panel.port })
        closePanel.close = panel.close
      }
      if (deps.poll) {
        const tick = () => void deps.poll!().catch(() => {})
        const set = deps.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
        handle = set(tick, 60_000)
        timerSet = true
      }
    },
    async cleanup() {
      const clear = deps.clearIntervalFn ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))
      if (timerSet) clear(handle)
      timerSet = false
      handle = undefined
      await closePanel.close()
    },
  }
}

// The OpenCode plugin shell. The domain above is plain code; this is the only OpenCode-specific part.
export default Plugin.define({
  id: 'opencode-superagent',
  async setup(ctx) {
    const kv: KV = {
      get: key => ctx.storage.get(key) as Promise<never>,
      set: (key, value) => ctx.storage.set(key, value as never),
      remove: key => ctx.storage.remove(key),
      scan: async prefix => {
        const rows: { key: string; value: unknown }[] = []
        let cursor: string | undefined
        do {
          const page = await ctx.storage.scan({ prefix, limit: 100, after: cursor })
          rows.push(...page.entries.map(entry => ({ key: entry.key, value: entry.value })))
          cursor = page.next
        } while (cursor)
        return rows
      },
    }
    const sessions: SessionPort = {
      create: (title: string) => ctx.session.create({ title }).then(info => ({ sessionID: info.id })),
      prompt: (sessionID: string, text: string) => ctx.session.prompt({ sessionID, text }).then(() => {}),
      interrupt: (sessionID: string) => ctx.session.interrupt({ sessionID }).then(() => {}),
    }
    const projectID = ctx.location.project.id
    const worktrees: WorktreePort = {
      create: (name: string) => ctx.worktree.create({ projectID, name }),
    }
    const generate: GeneratePort = {
      text: async opts => ctx.experimental.generate.text({ prompt: opts.prompt }),
    }
    const toolsAdapter: ToolEditor = {
      namespace: () => {},
      add: tool => {
        void ctx.tool.transform(editor => {
          editor.add({
            name: tool.name,
            description: tool.description,
            input: {
              type: 'object',
              properties: {
                ticket: { type: 'string', description: 'The ticket id, as given in your briefing.' },
                kind: { type: 'string', enum: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'] },
                text: { type: 'string', description: 'One short factual sentence.' },
              },
              required: ['ticket', 'kind', 'text'],
              additionalProperties: false,
            },
            execute: (input, context) => tool.execute(input, { sessionID: context.sessionID }) as Promise<never>,
          })
        })
      },
      update: () => {},
      remove: () => {},
    }
    const config = (ctx.options ?? {}) as { repository?: string; allowedActors?: string[]; pollSeconds?: number; agentLogin?: string; panelPort?: number }
    const repository = config.repository ?? 'owner/repo'
    const token = process.env.GITHUB_TOKEN ?? ''
    const agentLogin = config.agentLogin ?? 'agent-bot'
    const allowedActors = config.allowedActors ?? []

    const app = assemble({
      kv,
      sessions,
      worktrees,
      token,
      tools: toolsAdapter,
      generate,
      config: { repository, allowedActors },
      panel: { port: config.panelPort },
      poll: () => {
        const source = new GitHubSource({
          config: { repository, allowedActors, pollSeconds: config.pollSeconds ?? 60, agentLogin },
          token,
          kv,
          fetchJSON: async (url, init) => {
            const response = await fetch(url, init)
            return { status: response.status, json: () => response.json(), headers: response.headers }
          },
          fetchThread: async apiUrl => {
            const response = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })
            return response.json() as never
          },
          intake: trigger => {
            void app.engine.intake(trigger).catch(() => {})
            return Promise.resolve('evaluated')
          },
        })
        return source.pollOnce()
      },
    })
    await app.start()
    return () => app.cleanup()
  },
})
