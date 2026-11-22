import { z } from 'zod'
import type { KV } from './kv.ts'

/**
 * lite版的领域模型与 Engine。
 *
 * 与完整版（plugin-opencode/core）相同的词汇与不变量：
 * - Trigger 不可变，disposition 是幂等单元；
 * - accept 原子创建 Mandate + Ticket，授权与上下文分离；
 * - Ticket 自定义状态，不跟随 Executor；
 * - 人的后续消息经 Subscription 扇出，不需再评估，可 resume 已结束的工单。
 *
 * 简化：Source 只有本会话消息（'session'）；gate 只走 explicit（会话操作者的显式指令），
 * 没有模型研判层；没有 outbox 与策略版本化。
 */

export const TriggerSchema = z.object({
  id: z.string().min(1),
  source: z.literal('session'),
  actorId: z.string().min(1),
  text: z.string().min(1),
  threadKey: z.string().min(1),
  at: z.number().int(),
}).strict()
export type Trigger = z.output<typeof TriggerSchema>

export const ReportSchema = z.object({
  kind: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
  text: z.string(),
  at: z.number().int(),
}).strict()
export type Report = z.output<typeof ReportSchema>

export const MandateSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  strength: z.literal('explicit'),
  actorId: z.string().min(1),
  via: z.literal('session'),
  createdAt: z.number().int(),
}).strict()
export type Mandate = z.output<typeof MandateSchema>

export const TicketSchema = z.object({
  id: z.string().min(1),
  mandateId: z.string().min(1),
  status: z.enum(['open', 'ended']),
  outcome: z.enum(['completed', 'dropped', 'stopped']).optional(),
  sessionId: z.string().optional(),
  directory: z.string().optional(),
  subscriptions: z.array(z.string()),
  reports: z.array(ReportSchema),
  /** A structured question that waits for a person's answer. */
  attention: z.object({ question: z.string(), at: z.number().int() }).optional(),
}).strict()
export type Ticket = z.output<typeof TicketSchema>

export const DecisionSchema = z.object({
  id: z.string().min(1),
  triggerId: z.string().min(1),
  kind: z.enum(['accept', 'stop', 'ignore']),
  reason: z.string().optional(),
  ticketId: z.string().optional(),
  at: z.number().int(),
}).strict()
export type Decision = z.output<typeof DecisionSchema>

export interface ThreadState {
  key: string
  triggerIds: string[]
  ticketIds: string[]
  decisionIds: string[]
}

/** What intake did with one trigger. */
export type Disposition = 'evaluated' | 'fannedOut' | 'filtered'

export type EngineEvent =
  | { type: 'accept'; ticket: Ticket; trigger: Trigger }
  | { type: 'fanout'; ticketId: string; text: string }
  | { type: 'resume'; ticketId: string; text: string }
  | { type: 'stop'; ticketId: string }

export interface EngineDeps {
  kv: KV
  clock: () => number
  /** A fresh ticket id; injected so tests can assert deterministically. */
  newTicketId: () => string
  newMandateId: () => string
  newDecisionId: () => string
  notify(event: EngineEvent): void
}

const threadKeyOf = (key: string) => `thread/${key}`
const ticketKeyOf = (id: string) => `ticket/${id}`
const mandateKeyOf = (id: string) => `mandate/${id}`

export class LiteEngine {
  private readonly kv: KV
  private readonly clock: () => number
  private readonly ids: Pick<EngineDeps, 'newTicketId' | 'newMandateId' | 'newDecisionId'>
  private readonly notify: EngineDeps['notify']
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(deps: EngineDeps) {
    this.kv = deps.kv
    this.clock = deps.clock
    this.ids = deps
    this.notify = deps.notify
  }

  /** Serializes all work on one thread: evals run one at a time, in arrival order. */
  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const last = this.chains.get(key) ?? Promise.resolve()
    const next = last.then(work, work)
    this.chains.set(key, next.catch(() => {}))
    return next
  }

  async thread(key: string): Promise<ThreadState | undefined> {
    return this.kv.get<ThreadState>(threadKeyOf(key))
  }

  async tickets(): Promise<Ticket[]> {
    return (await this.kv.scan('ticket/')).map(row => row.value as Ticket)
  }

  async mandateOf(ticketId: string): Promise<Mandate | undefined> {
    const ticket = await this.kv.get<Ticket>(ticketKeyOf(ticketId))
    if (!ticket) return undefined
    return this.kv.get<Mandate>(mandateKeyOf(ticket.mandateId))
  }

  /**
   * A person's message on a thread whose ticket references it (`#t3 text`) reaches that
   * ticket directly, with no eval: the reference is the explicit routing.
   */
  async followUp(ticketId: string, trigger: Trigger): Promise<Disposition> {
    const seen = await this.kv.get<Disposition>(`disposition/${trigger.id}`)
    if (seen) return seen === 'evaluated' ? 'filtered' : seen
    const ticket = await this.kv.get<Ticket>(ticketKeyOf(ticketId))
    if (!ticket) return 'filtered'
    if (ticket.status === 'ended' && ticket.outcome === 'stopped') return 'filtered'
    return this.serialize(`ticket:${ticketId}`, async () => {
      const replayed = await this.kv.get<Disposition>(`disposition/${trigger.id}`)
      if (replayed) return replayed
      const current = await this.kv.get<Ticket>(ticketKeyOf(ticketId))
      if (!current || (current.status === 'ended' && current.outcome === 'stopped')) return 'filtered'
      if (current.status === 'ended') {
        // A person's message resumes an ended ticket under the same Mandate, with no new eval.
        current.status = 'open'
        current.outcome = undefined
        await this.kv.set(ticketKeyOf(ticketId), current)
        await this.recordThread(trigger, current)
        await this.kv.set(`disposition/${trigger.id}`, 'fannedOut')
        this.notify({ type: 'resume', ticketId, text: trigger.text })
        return 'fannedOut'
      }
      await this.recordThread(trigger, current)
      await this.kv.set(`disposition/${trigger.id}`, 'fannedOut')
      this.notify({ type: 'fanout', ticketId, text: trigger.text })
      return 'fannedOut'
    })
  }

  /**
   * New work arrives on a thread. The session operator's explicit message is the gate:
   * it always admits, with `explicit` strength. Accept creates Mandate + Ticket atomically.
   */
  async intake(trigger: Trigger): Promise<Disposition> {
    // A replayed trigger must never open work twice: its disposition is the unit of idempotence.
    const seen = await this.kv.get<Disposition>(`disposition/${trigger.id}`)
    if (seen) return seen === 'evaluated' ? 'filtered' : seen
    return this.serialize(trigger.threadKey, () => this.intakeNow(trigger))
  }

  private async intakeNow(trigger: Trigger): Promise<Disposition> {
    const disposition = await this.kv.get<Disposition>(`disposition/${trigger.id}`)
    if (disposition) return disposition === 'evaluated' ? 'filtered' : disposition
    const thread = (await this.thread(trigger.threadKey)) ?? { key: trigger.threadKey, triggerIds: [], ticketIds: [], decisionIds: [] }
    const tickets = await Promise.all(thread.ticketIds.map(id => this.kv.get<Ticket>(ticketKeyOf(id))!))
    const live = tickets.filter((t): t is Ticket => t !== undefined && t.status === 'open')

    // A person's message on a thread with tickets reaches them without an eval.
    if (live.length > 0) {
      thread.triggerIds.push(trigger.id)
      await this.kv.set(threadKeyOf(thread.key), thread)
      for (const ticket of live) {
        await this.kv.set(`disposition/${trigger.id}`, 'fannedOut')
        this.notify({ type: 'fanout', ticketId: ticket.id, text: trigger.text })
      }
      return 'fannedOut'
    }

    // The explicit gate: a session operator's direct message always admits.
    thread.triggerIds.push(trigger.id)
    const ticket = await this.openTicket(trigger)
    thread.ticketIds.push(ticket.id)
    const decision: Decision = {
      id: this.ids.newDecisionId(),
      triggerId: trigger.id,
      kind: 'accept',
      ticketId: ticket.id,
      at: this.clock(),
    }
    await this.kv.set(`decision/${decision.id}`, decision)
    thread.decisionIds.push(decision.id)
    await this.kv.set(threadKeyOf(thread.key), thread)
    await this.kv.set(`disposition/${trigger.id}`, 'evaluated')
    return 'evaluated'
  }

  private async recordThread(trigger: Trigger, ticket: Ticket): Promise<void> {
    const thread = (await this.thread(trigger.threadKey)) ?? { key: trigger.threadKey, triggerIds: [], ticketIds: [], decisionIds: [] }
    if (!thread.ticketIds.includes(ticket.id)) thread.ticketIds.push(ticket.id)
    if (!thread.triggerIds.includes(trigger.id)) thread.triggerIds.push(trigger.id)
    await this.kv.set(threadKeyOf(thread.key), thread)
  }

  private async openTicket(trigger: Trigger): Promise<Ticket> {
    const mandate: Mandate = {
      id: this.ids.newMandateId(),
      scope: trigger.text,
      strength: 'explicit',
      actorId: trigger.actorId,
      via: 'session',
      createdAt: this.clock(),
    }
    await this.kv.set(mandateKeyOf(mandate.id), mandate)
    const ticket: Ticket = {
      id: this.ids.newTicketId(),
      mandateId: mandate.id,
      status: 'open',
      subscriptions: [trigger.threadKey],
      reports: [],
    }
    await this.kv.set(ticketKeyOf(ticket.id), ticket)
    this.notify({ type: 'accept', ticket, trigger })
    return ticket
  }

  /** A person stops the work: the mandate loses its force and nothing may resume it. */
  async stop(ticketId: string): Promise<void> {
    const ticket = await this.kv.get<Ticket>(ticketKeyOf(ticketId))
    if (!ticket || ticket.status === 'ended') return
    ticket.status = 'ended'
    ticket.outcome = 'stopped'
    await this.kv.set(ticketKeyOf(ticketId), ticket)
    this.notify({ type: 'stop', ticketId })
  }
}
