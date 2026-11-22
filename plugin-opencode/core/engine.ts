import type { KV } from './kv.ts'
import type { Decision, Disposition, Mandate, Ticket, Trigger } from './model.ts'
import { newMandateId, newTicketId } from './ids.ts'
import type { GateResult, Policy } from './policy.ts'
import { gate, revalidate } from './policy.ts'

/** The model's judgement layer of Eval: turns a batch onto a thread into a decision. Deterministic gate runs before it. */
export interface Assessor {
  assess(input: { batch: Trigger[]; thread: ThreadState; tickets: readonly Ticket[] }): Promise<Decision>
  /** Optional: decides whether a person's follow-up on a live ticket's thread belongs to that ticket. */
  classifyFollowUp?(input: { trigger: Trigger; thread: ThreadState }): Promise<{ inScope: boolean }>
}

export interface ThreadState {
  key: string
  triggers: Trigger[]
  ticketIds: string[]
  decisions: (Decision & { at: number })[]
}

export interface EngineDeps {
  kv: KV
  policy: Policy
  assessor: Assessor
  clock: () => number
  notify(event: { type: 'fanout'; ticketId: string; trigger: Trigger } | { type: 'decision'; decision: Decision; threadKey: string } | { type: 'notice'; ticketId: string; text: string }): void
}

const threadKeyOf = (key: string) => `thread/${key}`
const ticketKeyOf = (id: string) => `ticket/${id}`
const mandateKeyOf = (id: string) => `mandate/${id}`
const pendingKeyOf = (key: string) => `pending/${key}`

export class Engine {
  policy: Policy
  /** Wiring for delivery: called when a person's message resumes an ended ticket. Set by the executor glue. */
  onPersonMessage?: (ticketId: string, text: string) => void
  private readonly kv: KV
  private readonly assessor: Assessor
  private readonly clock: () => number
  private readonly notify: EngineDeps['notify']
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(deps: EngineDeps) {
    this.kv = deps.kv
    this.policy = deps.policy
    this.assessor = deps.assessor
    this.clock = deps.clock
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

  async intake(trigger: Trigger): Promise<Disposition> {
    // A replayed trigger must never open work twice: its disposition is the unit of idempotence.
    const seen = await this.kv.get<Disposition>(`disposition/${trigger.id}`)
    if (seen) return seen === 'evaluated' ? 'filtered' : seen
    return this.serialize(trigger.threadKey, () => this.intakeNow(trigger))
  }

  private async intakeNow(trigger: Trigger): Promise<Disposition> {
    const disposition = await this.kv.get<Disposition>(`disposition/${trigger.id}`)
    if (disposition) return disposition === 'evaluated' ? 'filtered' : disposition
    const thread = (await this.thread(trigger.threadKey)) ?? { key: trigger.threadKey, triggers: [], ticketIds: [], decisions: [] }
    const tickets = await Promise.all(thread.ticketIds.map(id => this.kv.get<Ticket>(ticketKeyOf(id))!))
    const live = tickets.filter((t): t is Ticket => t !== undefined && t.status === 'open')
    const ended = tickets.filter((t): t is Ticket => t !== undefined && t.status === 'ended')

    // A person's message on a ticket's own thread reaches it without an eval.
    // Pause stops input delivery too: triggers are recorded, nothing is fanned out.
    if (this.policy.paused) return await this.record(thread, trigger, 'recorded')
    // A person's message on a live ticket's thread reaches it without an eval — unless the
    // assessor hands it back, in which case it becomes a new-work candidate like any other.
    const liveTarget = live[0]
    if (liveTarget && this.assessor.classifyFollowUp) {
      const { inScope } = await this.assessor.classifyFollowUp({ trigger, thread })
      if (!inScope) {
        thread.triggers.push(trigger)
        const verdictFor = gate(this.policy, trigger, tickets.filter((t): t is Ticket => t !== undefined))
        if (verdictFor.admissible && !verdictFor.recordOnly) {
          const decision = await this.assess(thread, tickets.filter((t): t is Ticket => t !== undefined))
          if (decision.kind === 'accept') {
            const newTicket = await this.openTicket(trigger, decision, verdictFor.strength)
            thread.ticketIds.push(newTicket.id)
            await this.kv.set(threadKeyOf(thread.key), thread)
            return await this.record(thread, trigger, 'evaluated')
          }
        }
        await this.kv.set(threadKeyOf(thread.key), thread)
        return await this.record(thread, trigger, 'filtered')
      }
    }
    const resumable = !trigger.actor.bot && (live.length > 0 || ended.find(t => t.outcome !== 'stopped'))
    if (resumable) {
      const target = live[0] ?? ended.find(t => t.outcome !== 'stopped')!
      if (target.status === 'ended') {
        const mandate = await this.kv.get<Mandate>(mandateKeyOf(target.mandateId))
        if (!mandate || !revalidate(this.policy, mandate)) return await this.record(thread, trigger, 'filtered')
        target.status = 'open'
        target.outcome = undefined
        await this.kv.set(ticketKeyOf(target.id), target)
        thread.triggers.push(trigger)
        await this.kv.set(threadKeyOf(thread.key), thread)
        this.onPersonMessage?.(target.id, trigger.text)
        return await this.record(thread, trigger, 'fannedOut')
      }
      thread.triggers.push(trigger)
      await this.kv.set(threadKeyOf(thread.key), thread)
      this.notify({ type: 'fanout', ticketId: target.id, trigger })
      return await this.record(thread, trigger, 'fannedOut')
    }

    const verdict = gate(this.policy, trigger, tickets.filter((t): t is Ticket => t !== undefined))
    if (this.policy.paused) return await this.record(thread, trigger, 'recorded')
    if (!verdict.admissible) return await this.record(thread, trigger, 'filtered')
    if (verdict.recordOnly) return await this.record(thread, trigger, 'recorded')

    thread.triggers.push(trigger)
    const decision = await this.assess(thread, tickets.filter((t): t is Ticket => t !== undefined))
    if (decision.kind === 'accept') {
      const ticket = await this.openTicket(trigger, decision, verdict.strength)
      thread.ticketIds.push(ticket.id)
      await this.kv.set(threadKeyOf(thread.key), thread)
      return await this.record(thread, trigger, 'evaluated')
    }
    if (decision.kind === 'unavailable') {
      await this.kv.set(threadKeyOf(thread.key), thread)
      const queued = (await this.kv.get<Trigger[]>(pendingKeyOf(trigger.threadKey))) ?? []
      queued.push(trigger)
      await this.kv.set(pendingKeyOf(trigger.threadKey), queued)
      return await this.record(thread, trigger, 'evaluated')
    }
    await this.kv.set(threadKeyOf(thread.key), thread)
    return await this.record(thread, trigger, 'evaluated')
  }

  /** Threads whose triggers wait for a retry after an unavailable eval. */
  async pendingThreads(): Promise<string[]> {
    return (await this.kv.scan('pending/')).map(row => row.key.slice('pending/'.length))
  }

  /** Re-runs the assessment for every trigger queued by unavailable evals on one thread. */
  async retryPending(threadKey: string): Promise<void> {
    const queued = await this.kv.get<Trigger[]>(pendingKeyOf(threadKey))
    if (!queued) return
    await this.kv.remove(pendingKeyOf(threadKey))
    for (const trigger of queued) {
      await this.kv.remove(`disposition/${trigger.id}`)
      await this.intake(trigger)
    }
  }

  /** The Ticket follows a pull request once discovered; its thread subscribes for review comments. */
  async followPr(ticketId: string, number: number): Promise<void> {
    const ticket = await this.kv.get<Ticket>(ticketKeyOf(ticketId))
    if (!ticket) throw new Error(`unknown ticket ${ticketId}`)
    const threadKey = `github:${this.policy.github.repository}:pr:${number}`
    if (!ticket.subscriptions.includes(threadKey)) ticket.subscriptions.push(threadKey)
    await this.kv.set(ticketKeyOf(ticketId), ticket)
    const followed = await this.followedPrs(ticketId)
    if (!followed.some(pr => pr.number === number)) followed.push({ number, open: true })
    await this.kv.set(`pr/${ticketId}`, followed)
  }

  async followedPrs(ticketId: string): Promise<Array<{ number: number; open: boolean }>> {
    return (await this.kv.get<Array<{ number: number; open: boolean }>>(`pr/${ticketId}`)) ?? []
  }

  /** Reports recorded outside the worker: pull-request events and CI results land here. */
  async reportExternal(ticketId: string, report: { kind: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'; text: string; at: number }): Promise<void> {
    const ticket = await this.kv.get<Ticket>(ticketKeyOf(ticketId))
    if (!ticket) throw new Error(`unknown ticket ${ticketId}`)
    ticket.reports.push(report)
    await this.kv.set(ticketKeyOf(ticketId), ticket)
  }

  /**
   * A followed pull request closed. The ticket is done when none of its pull requests remain
   * open and the last report is ready; the outcome follows the close.
   */
  async prClosed(ticketId: string, number: number, merged: boolean): Promise<void> {
    const followed = await this.followedPrs(ticketId)
    const entry = followed.find(pr => pr.number === number)
    if (entry) entry.open = false
    await this.kv.set(`pr/${ticketId}`, followed)
    const ticket = await this.kv.get<Ticket>(ticketKeyOf(ticketId))
    if (!ticket || ticket.status !== 'open') return
    if (followed.some(pr => pr.open)) return
    const last = ticket.reports.at(-1)
    if (last?.kind !== 'ready') return
    await this.endTicket(ticketId, merged ? 'completed' : 'dropped')
    this.notify({ type: 'notice', ticketId, text: merged ? `pull request #${number} merged; work complete.` : `pull request #${number} closed without merge; work dropped.` })
  }

  private async assess(thread: ThreadState, tickets: readonly Ticket[]): Promise<Decision & { at: number }> {
    let decision: Decision
    try {
      decision = await this.assessor.assess({ batch: [thread.triggers.at(-1)!], thread, tickets })
    } catch (error) {
      decision = { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
    const stamped = { ...decision, at: this.clock() }
    thread.decisions.push(stamped)
    this.notify({ type: 'decision', decision, threadKey: thread.key })
    return stamped
  }

  private async openTicket(trigger: Trigger, decision: Decision & { at?: number }, strength: 'explicit' | 'inferred'): Promise<Ticket> {
    const mandate: Mandate = {
      id: newMandateId(),
      policyVersion: this.policy.policyVersion,
      scope: decision.scope ?? trigger.text,
      strength,
      rules: [],
      actor: trigger.actor,
      via: trigger.source,
      createdAt: this.clock(),
    }
    await this.kv.set(mandateKeyOf(mandate.id), mandate)
    const ticket: Ticket = {
      id: newTicketId(),
      mandateId: mandate.id,
      status: 'open',
      subscriptions: [trigger.threadKey],
      reports: [],
      assignmentIds: [],
      deliveryFailed: false,
    }
    await this.kv.set(ticketKeyOf(ticket.id), ticket)
    return ticket
  }

  async endTicket(ticketId: string, outcome: 'completed' | 'dropped' | 'stopped'): Promise<void> {
    const ticket = await this.kv.get<Ticket>(ticketKeyOf(ticketId))
    if (!ticket || ticket.status === 'ended') return
    ticket.status = 'ended'
    ticket.outcome = outcome
    await this.kv.set(ticketKeyOf(ticketId), ticket)
  }

  /** A person stops the work: the mandate loses its force and bot messages may not resume it. */
  async stop(ticketId: string): Promise<void> {
    await this.endTicket(ticketId, 'stopped')
  }

  private async record(thread: ThreadState, trigger: Trigger, disposition: Disposition): Promise<Disposition> {
    await this.kv.set(`disposition/${trigger.id}`, disposition)
    return disposition
  }
}

export type { GateResult }
