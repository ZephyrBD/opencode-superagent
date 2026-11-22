import { createHash } from 'node:crypto'
import { Plugin } from '@opencode/plugin'
import { z } from 'zod'
import { LiteEngine, ReportSchema, TicketSchema, type Disposition, type EngineEvent, type Ticket, type Trigger } from './core.ts'
import { LiteExecutor, type SessionPort, type WorktreePort } from './executor.ts'
import type { KV } from './kv.ts'

export interface ToolContext {
  sessionID?: string
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the tool input; a default `ticket` schema applies when omitted. */
  input?: Record<string, unknown>
  execute: (input: unknown, context?: ToolContext) => Promise<unknown>
}

export interface ToolEditor {
  add(tool: ToolDefinition): void
}

export interface AssembleDeps {
  kv: KV
  sessions: SessionPort
  worktrees?: WorktreePort
  tools: ToolEditor
  /** Concurrent worker slots. */
  workerLimit?: number
  /** A `#t3 text` reference routes to that ticket without an eval. */
  followUpRef?: RegExp
}

export interface AssembledApp {
  engine: LiteEngine
  executor: LiteExecutor
  /** One session message: routes to a referenced ticket, or opens new work. */
  submit(sessionID: string, text: string): Promise<Disposition>
  start(): Promise<void>
  cleanup(): Promise<void>
  /** Tests may inspect what the notify wiring received. */
  events: EngineEvent[]
}

const ReportInputSchema = z.object({
  ticket: z.string().min(1),
  kind: ReportSchema.shape.kind,
  text: z.string(),
}).strict()

const FollowUpInputSchema = z.string().min(1)

const threadKeyOf = (sessionID: string) => `session:${sessionID}`
/** Content hash: the same message resubmitted is the same trigger, so intake stays idempotent. */
const triggerIdOf = (sessionID: string, text: string) =>
  `t-${createHash('sha1').update(`${sessionID}\u0000${text}`).digest('hex').slice(0, 16)}`

/** Wires the domain objects together. Pure: tests drive it with fakes. */
export const assemble = (deps: AssembleDeps): AssembledApp => {
  const events: EngineEvent[] = []
  const engine = new LiteEngine({
    kv: deps.kv,
    clock: () => Date.now(),
    newTicketId: (() => {
      let next = 1
      return () => `t${next++}`
    })(),
    newMandateId: (() => {
      let next = 1
      return () => `m${next++}`
    })(),
    newDecisionId: (() => {
      let next = 1
      return () => `d${next++}`
    })(),
    notify: event => {
      events.push(event)
      if (event.type === 'accept') void executor.dispatch(event.ticket, [event.trigger.text]).catch(() => {})
      if (event.type === 'fanout') void executor.deliver(event.ticketId, event.text).catch(() => {})
      if (event.type === 'resume') {
        executor.onPersonMessage(event.ticketId)
        void executor.deliver(event.ticketId, event.text).catch(() => {})
      }
      if (event.type === 'stop') void executor.stop(event.ticketId).catch(() => {})
    },
  })
  const executor = new LiteExecutor({
    sessions: deps.sessions,
    worktrees: deps.worktrees,
    kv: deps.kv,
    limit: deps.workerLimit,
  })

  const followUpRef = deps.followUpRef ?? /^#(\S+)\s+([\s\S]+)$/

  const app: AssembledApp = {
    engine,
    executor,
    events,
    async submit(sessionID, text) {
      const trigger: Trigger = {
        id: triggerIdOf(sessionID, text),
        source: 'session',
        actorId: 'operator',
        text,
        threadKey: threadKeyOf(sessionID),
        at: Date.now(),
      }
      const ref = text.match(followUpRef)
      if (ref) {
        const disposition = await engine.followUp(ref[1]!, {
          ...trigger,
          text: ref[2]!,
        })
        if (disposition !== 'filtered') return disposition
        // Unknown or stopped reference falls through to a normal eval on the thread.
      }
      return engine.intake(trigger)
    },
    async start() {
      await executor.recover()
    },
    async cleanup() {},
  }

  deps.tools.add({
    name: 'superagent_report_ticket',
    description: 'Report the structured state of your ticket: progress, waiting, ready, blocked, failed or dropped.',
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

  deps.tools.add({
    name: 'superagent_tickets',
    description: 'List every ticket with its status, latest report and pending attention question.',
    execute: async () => {      const tickets = await engine.tickets()
      return {
        content: tickets
          .map(ticket => {
            const last = ticket.reports.at(-1)
            const attention = ticket.attention ? ` attention: ${ticket.attention.question}` : ''
            return `${ticket.id} ${ticket.status}${ticket.outcome ? ` (${ticket.outcome})` : ''}${last ? ` — ${last.kind}: ${last.text}` : ''}${attention}`
          })
          .join('\n') || 'no tickets',
      }
    },
  })

  deps.tools.add({
    name: 'superagent_stop_ticket',
    description: 'Stop a ticket: the worker is interrupted and the mandate loses its force.',
    input: {
      type: 'object',
      properties: { ticket: { type: 'string', description: 'The ticket id.' } },
      required: ['ticket'],
      additionalProperties: false,
    },
    execute: async rawInput => {
      const input = z.object({ ticket: FollowUpInputSchema }).strict().parse(rawInput)
      await engine.stop(input.ticket)
      return { content: `stopped ${input.ticket}` }
    },
  })

  return app
}

// The OpenCode plugin shell. The domain above is plain code; this is the only OpenCode-specific part.
export default Plugin.define({
  id: 'opencode-superagent-lite',
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
    const config = (ctx.options ?? {}) as { workerLimit?: number }
    const toolsAdapter: ToolEditor = {
      add: tool => {
        void ctx.tool.transform(editor => {
          editor.add({
            name: tool.name,
            description: tool.description,
            input: tool.input ?? {
              type: 'object',
              properties: { ticket: { type: 'string', description: 'The ticket id.' } },
              required: ['ticket'],
              additionalProperties: false,
            },
            execute: (input, context) => tool.execute(input, { sessionID: context.sessionID }) as Promise<never>,
          })
        })
      },
    }

    const app = assemble({
      kv,
      sessions,
      worktrees,
      tools: toolsAdapter,
      workerLimit: config.workerLimit,
    })

    await ctx.command.transform(editor => {
      editor.add({
        name: 'work',
        description: 'Submit work to the superagent: "/work <task>", or "/work #t3 <note>" to reach ticket t3 directly.',
        execute: async ({ sessionID, prompt }) => {
          const text = prompt.text.trim()
          if (!text) return
          await app.submit(sessionID, text)
        },
      })
    })

    await app.start()
    return () => app.cleanup()
  },
})
