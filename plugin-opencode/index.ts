import { Plugin } from '@opencode/plugin'
import { z } from 'zod'
import { Engine } from './core/engine.ts'
import { Executor, type SessionPort, type WorktreePort } from './core/executor.ts'
import { LlmAssessor, type GeneratePort } from './core/assessor.ts'
import { FallbackAssessor, SessionOrchestrator } from './core/orchestrator.ts'
import { Outbox } from './core/outbox.ts'
import type { KV } from './core/kv.ts'
import { ReportSchema, type Ticket } from './core/model.ts'
import { GitHubSource } from './sources/github/index.ts'
import { FeishuSource, type FeishuCli } from './sources/feishu/index.ts'
import { cliFeishuCli } from './sources/feishu/cli.ts'
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
  /** The write side of GitHub origin threads; PR outcome notices go out through it. */
  channel?: { reply(threadKey: string, text: string): Promise<void> }
  /** The write side of Feishu origin threads. */
  feishuChannel?: { reply(threadKey: string, text: string): Promise<void> }
  /** Optional Feishu Source with its chat config; polls alongside GitHub when provided. */
  feishu?: { cli: FeishuCli; config?: { chats: Array<{ id: string; listen: 'mentions' | 'all' }>; pollSeconds: number } }
  /** GitHub Source wiring; constructed once so health state accumulates across polls. */
  github?: {
    config: { repository: string; allowedActors: string[]; pollSeconds: number; agentLogin: string }
    fetchJSON(url: string, init?: RequestInit): Promise<{ status: number; json(): Promise<unknown> }>
    fetchThread(apiUrl: string): Promise<{ number: number; comments: Array<{ id: number; body: string; html_url: string; created_at: string; user: { login: string; type: string } }>; state: string }>
  }
  /** Policy overrides: repository and allowed actors are the operator's decision. */
  config?: { repository?: string; allowedActors?: string[]; policyVersion?: string }
}

export interface AssembledApp {
  engine: Engine
  executor: Executor
  outbox: Outbox
  githubSource?: GitHubSource
  /** Runs one poll across every enabled source. */
  pollAll(): Promise<unknown[]>
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
        await executor.deliver(ticketId, inputs.join('\n'), (payload as { key?: string }).key)
      }
      if (kind === 'notice') {
        const origin = ticket.subscriptions[0]
        if (!origin || origin.includes(':pr:')) return
        const text = (payload as { text: string }).text
        if (origin.startsWith('feishu:')) {
          if (!deps.feishuChannel) return
          await deps.feishuChannel.reply(origin, text)
          return
        }
        if (!deps.channel) return
        await deps.channel.reply(origin, text)
      }
    },
  })

  const executor = new Executor({ sessions: deps.sessions, worktrees: deps.worktrees, kv: deps.kv, limit: 3 })
  const llmAssessor = new LlmAssessor({ generate: deps.generate ?? { text: async () => ({ text: '{"kind":"unavailable"}' }) } })
  const orchestrator = new SessionOrchestrator({ sessions: deps.sessions, fallback: llmAssessor })
  const assessor = new FallbackAssessor(orchestrator, llmAssessor)
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
        void outbox.enqueue('deliver', { ticketId: event.ticketId, inputs: [event.trigger.text], key: event.trigger.id }).catch(() => {})
      }
      if (event.type === 'notice') {
        void outbox.enqueue('notice', { ticketId: event.ticketId, text: event.text }).catch(() => {})
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
  const githubSource = deps.github
    ? new GitHubSource({
        config: deps.github.config,
        token: deps.token,
        kv: deps.kv,
        fetchJSON: deps.github.fetchJSON,
        fetchThread: deps.github.fetchThread,
        intake: trigger => engine.intake(trigger),
        follow: async (ticketId, number, head) => {
          await engine.followPr(ticketId, number)
          void head
        },
        prClosed: (ticketId, number, merged) => engine.prClosed(ticketId, number, merged),
      })
    : undefined
  const feishuSource = deps.feishu
    ? new FeishuSource({
        config: deps.feishu.config ?? { chats: [], pollSeconds: 30 },
        cli: deps.feishu.cli,
        kv: deps.kv,
        intake: trigger => engine.intake(trigger),
      })
    : undefined
  const app: AssembledApp = {
    engine,
    executor,
    outbox,
    githubSource,
    async pollAll() {
      const results: Promise<unknown>[] = []
      if (githubSource) results.push(githubSource.pollOnce())
      if (feishuSource) results.push(feishuSource.pollOnce())
      if (deps.poll) results.push(deps.poll())
      return Promise.all(results)
    },
    async start() {
      // Recover stored work first: a reload or crash must replay it before anything new launches.
      if (deps.recover) await deps.recover()
      else await outbox.recover()
      await executor.rebuild()
      // A restart ends running assignments; each open ticket starts again, oldest first, with a
      // recovery note. Tickets a person must answer stay held: restarting the host must not
      // launch a turn a blocked worker is not asking for.
      const tickets = (await deps.kv.scan('ticket/')).map(row => row.value as Ticket)
      const runningIds = new Set(
        (await deps.kv.scan('assignment/'))
          .map(row => row.value as Assignment)
          .filter(assignment => assignment.status === 'running')
          .map(assignment => assignment.ticketId),
      )
      const toRecover = tickets
        .filter(ticket => {
          if (ticket.status !== 'open' || !runningIds.has(ticket.id)) return false
          const last = ticket.reports.at(-1)
          return last?.kind !== 'blocked' && last?.kind !== 'failed'
        })
        .sort((a, b) => a.id.localeCompare(b.id))
      for (const ticket of toRecover) await executor.recoverTicket(ticket)
      if (deps.resumeDispatch) await deps.resumeDispatch()
      for (const key of await engine.pendingThreads()) await engine.retryPending(key)
      if (deps.panel) {
        const panel = await startPanel({ kv: deps.kv }, { port: deps.panel.port })
        closePanel.close = panel.close
      }
      if (deps.poll || feishuSource) {
        const tick = () => void app.pollAll().catch(() => {})
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
  return app
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
      lastAssistantText: async sessionID => {
        const messages = await ctx.session.context({ sessionID })
        const last = messages.at(-1)
        return typeof last === 'object' && last && 'text' in last ? String((last as { text?: unknown }).text ?? '') : ''
      },
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
    const config = (ctx.options ?? {}) as {
      repository?: string
      allowedActors?: string[]
      pollSeconds?: number
      agentLogin?: string
      panelPort?: number
      feishu?: { chats?: Array<{ id: string; listen: 'mentions' | 'all' }>; pollSeconds?: number; cliPath?: string }
    }
    const repository = config.repository ?? 'owner/repo'
    const token = process.env.GITHUB_TOKEN ?? ''
    const agentLogin = config.agentLogin ?? 'agent-bot'
    const allowedActors = config.allowedActors ?? []
    const githubFetch = async (url: string, init?: RequestInit) => {
      const response = await fetch(url, init)
      return { status: response.status, json: () => response.json(), headers: response.headers }
    }

    const app = assemble({
      kv,
      sessions,
      worktrees,
      token,
      tools: toolsAdapter,
      generate,
      config: { repository, allowedActors },
      panel: { port: config.panelPort },
      channel: {
        reply: async (threadKey, text) => {
          const [, repo, , number] = threadKey.split(':')
          await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: text }),
          })
        },
      },
      feishuChannel: {
        reply: async (threadKey, text) => {
          const [, conversation, root] = threadKey.split(':')
          if (!conversation || !root) return
          await cliFeishuCli(config.feishu?.cliPath ?? 'lark-cli').reply(conversation, root, `notice-${conversation}-${root}`, text)
        },
      },
      github: {
        config: { repository, allowedActors, pollSeconds: config.pollSeconds ?? 60, agentLogin },
        fetchJSON: githubFetch,
        fetchThread: async apiUrl => {
          const response = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })
          return response.json() as never
        },
      },
      feishu: config.feishu?.chats?.length
        ? {
            cli: cliFeishuCli(config.feishu.cliPath ?? 'lark-cli'),
            config: { chats: config.feishu.chats, pollSeconds: config.feishu.pollSeconds ?? 30 },
          }
        : undefined,
    })
    await app.start()
    return () => app.cleanup()
  },
})
