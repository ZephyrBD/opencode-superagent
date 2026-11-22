import type { KV } from './kv.ts'
import type { Assignment } from './assignment.ts'
import { newAssignmentId } from './ids.ts'
import type { Report, Ticket } from './model.ts'

export interface SessionPort {
  create(title: string, agent?: string): Promise<{ sessionID: string }>
  prompt(sessionID: string, text: string): Promise<void>
  interrupt(sessionID: string): Promise<void>
  /** Reads the session's latest assistant text; the orchestrator parses its verdict out of it. */
  lastAssistantText?(sessionID: string): Promise<string>
}

export interface WorktreePort {
  create(name: string): Promise<{ directory: string }>
}

export interface ExecutorDeps {
  sessions: SessionPort
  worktrees: WorktreePort
  kv: KV
  /** Concurrent worker slots. A person's message may take one extra emergency slot. */
  limit: number
  delay?: (ms: number) => Promise<void>
}

/** A passing failure worth retrying: provider outages and connection trouble, never a 4xx verdict. */
export const isTransient = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up/.test(message)) return true
  const status = message.match(/\b(408|429|5\d\d)\b/)
  return status !== null
}

class Semaphore {
  private running = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly size: number) {}
  async take(): Promise<void> {
    if (this.running < this.size) {
      this.running += 1
      return
    }
    return new Promise(resolve => this.waiters.push(() => {
      this.running += 1
      resolve()
    }))
  }
  release(): void {
    this.running -= 1
    this.waiters.shift()?.()
  }
}

/**
 * Runs Assignments: one worker session and one directory per Ticket. The Executor sits outside the
 * domain; the Ticket defines its own state and only structured reports move it.
 */
export class Executor {
  private readonly sessions: SessionPort
  private readonly worktrees: WorktreePort
  private readonly kv: KV
  private readonly slots: Semaphore
  private readonly delay: (ms: number) => Promise<void>
  private readonly emergency = new Semaphore(1)
  private readonly held = new Set<string>()
  /** In-memory view of tickets this executor launched; the KV copy is the durable truth. */
  private readonly live = new Map<string, Ticket>()
  /** Wiring: called by the engine when a person's message releases a held ticket. Set by the glue. */
  onDeliver?: (ticketId: string, text: string) => void

  constructor(deps: ExecutorDeps) {
    this.sessions = deps.sessions
    this.worktrees = deps.worktrees
    this.kv = deps.kv
    this.slots = new Semaphore(deps.limit)
    this.delay = deps.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Re-launches a ticket after a host restart: running assignments end, a recovery note leads the new one. */
  async recoverTicket(ticket: Ticket): Promise<void> {
    for (const assignmentId of ticket.assignmentIds ?? []) {
      await this.endAssignment(assignmentId, 'host restarted')
    }
    const carried = ticket.sessionId ? await this.unreadFor(ticket.sessionId) : []
    ticket.sessionId = undefined
    this.live.set(ticket.id, ticket)
    await this.save(ticket)
    await this.dispatch(ticket, carried, true)
  }

  /** Launches the ticket's worker (or delivers new inputs to a live one). Holds a worker slot for the turn. */
  async dispatch(ticket: Ticket, inputs: string[], recovery = false): Promise<void> {
    await this.slots.take()
    let assignment: Assignment | undefined
    try {
      assignment = { id: newAssignmentId(), ticketId: ticket.id, status: 'running', startedAt: Date.now() }
      await this.kv.set(`assignment/${assignment.id}`, assignment)
      ;(ticket.assignmentIds ??= []).push(assignment.id)
      this.live.set(ticket.id, ticket)
      if (!ticket.directory) {
        const { directory } = await this.worktrees.create(ticket.id)
        ticket.directory = directory
      }
      if (!ticket.sessionId) {
        const { sessionID } = await this.sessions.create(`worker-${ticket.id}`, 'worker')
        ticket.sessionId = sessionID
      }
      await this.save(ticket)
      const carried = await this.unreadFor(ticket.sessionId)
      await this.promptWithRetry(ticket, [...carried, ...inputs], recovery)
    } catch (error) {
      // The failed report carries the failure; rethrowing would only make the outbox retry a lost launch.
      await this.endAssignment(assignment!.id, error instanceof Error ? error.message : String(error))
      await this.report(ticket.id, { kind: 'failed', text: `launch failed: ${error instanceof Error ? error.message : String(error)}`, at: Date.now() })
    } finally {
      this.slots.release()
    }
  }

  /** A passing failure is retried first, three times with a growing backoff; any other error fails at once. */
  private async promptWithRetry(ticket: Ticket, inputs: string[], recovery = false): Promise<void> {
    let delayMs = 2000
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.sessions.prompt(ticket.sessionId!, this.brief(ticket, inputs, recovery))
        return
      } catch (error) {
        if (attempt >= 2 || !isTransient(error)) throw error
        await this.delay(delayMs)
        delayMs *= 2
      }
    }
  }

  /** Ends an assignment independently of the ticket: replacements, restarts and retries go through here. */
  async endAssignment(assignmentId: string, endReason: string): Promise<void> {
    const assignment = await this.kv.get<Assignment>(`assignment/${assignmentId}`)
    if (!assignment || assignment.status === 'ended') return
    assignment.status = 'ended'
    assignment.endReason = endReason
    assignment.endedAt = Date.now()
    await this.kv.set(`assignment/${assignmentId}`, assignment)
  }

  /** Delivers a new input to a live worker. Refuses while the ticket is held after blocked/failed. */
  async deliver(ticketId: string, text: string, key?: string): Promise<void> {
    if (this.held.has(ticketId)) throw new Error(`ticket ${ticketId} is held: waiting for a person`)
    const ticket = await this.load(ticketId)
    if (!ticket?.sessionId) throw new Error(`ticket ${ticketId} has no live worker`)
    // A replayed delivery (outbox recover) must not prompt the worker twice.
    if (key && (await this.kv.get(`delivered/${key}`))) return
    // A person's message may use the emergency slot when normal slots are full.
    await this.emergency.take()
    try {
      await this.recordInput(ticket.sessionId, text)
      await this.sessions.prompt(ticket.sessionId, text)
      if (key) await this.kv.set(`delivered/${key}`, { at: Date.now() })
    } finally {
      this.emergency.release()
    }
  }

  /** An input counts as read once a report follows it; unread inputs ride along on a replacement assignment. */
  private async recordInput(sessionId: string, text: string): Promise<void> {
    const ledger = (await this.kv.get<Array<{ text: string; confirmed: boolean }>>(`taken/${sessionId}`)) ?? []
    ledger.push({ text, confirmed: false })
    await this.kv.set(`taken/${sessionId}`, ledger)
  }

  private async unreadFor(sessionId: string): Promise<string[]> {
    const ledger = (await this.kv.get<Array<{ text: string; confirmed: boolean }>>(`taken/${sessionId}`)) ?? []
    return ledger.filter(item => !item.confirmed).map(item => item.text)
  }

  private async confirmInputs(sessionId: string): Promise<void> {
    const ledger = (await this.kv.get<Array<{ text: string; confirmed: boolean }>>(`taken/${sessionId}`)) ?? []
    if (ledger.length === 0) return
    await this.kv.set(`taken/${sessionId}`, ledger.map(item => ({ ...item, confirmed: true })))
  }

  /** The report_ticket tool lands here. Only structured reports move the ticket. */
  async report(ticketId: string, report: Report): Promise<void> {
    const ticket = await this.load(ticketId)
    if (!ticket) throw new Error(`unknown ticket ${ticketId}`)
    if (ticket.sessionId) await this.confirmInputs(ticket.sessionId)
    ticket.reports.push(report)
    if (report.kind === 'ready') {
      ticket.status = 'ended'
      ticket.outcome = ticket.closedWithoutMerge ? 'dropped' : 'completed'
    }
    if (report.kind === 'dropped') {
      ticket.status = 'ended'
      ticket.outcome = 'dropped'
    }
    if (report.kind === 'blocked' || report.kind === 'failed') this.held.add(ticketId)
    if (report.kind === 'progress' || report.kind === 'waiting') this.held.delete(ticketId)
    if (report.kind === 'blocked') ticket.attention = { question: report.text, at: report.at }
    if (report.kind === 'progress' || report.kind === 'waiting') ticket.attention = undefined
    await this.save(ticket)
  }

  /** Rebuilds in-memory hold state from the durable reports, so a reload keeps blocked tickets held. */
  async rebuild(): Promise<void> {
    const rows = await this.kv.scan('ticket/')
    for (const row of rows) {
      const ticket = row.value as Ticket
      const last = ticket.reports.at(-1)
      if (last && (last.kind === 'blocked' || last.kind === 'failed')) this.held.add(ticket.id)
    }
  }

  /** A person's message reached a held ticket: it resumes its worker. */
  onPersonMessage(ticketId: string): void {
    this.held.delete(ticketId)
    const ticket = this.live.get(ticketId)
    if (ticket) {
      ticket.attention = undefined
      void this.save(ticket)
      return
    }
    void this.kv.get<Ticket>(`ticket/${ticketId}`).then(stored => {
      if (stored?.attention === undefined) return
      stored.attention = undefined
      return this.kv.set(`ticket/${ticketId}`, stored)
    }).catch(() => {})
  }

  private brief(ticket: Ticket, inputs: string[], recovery = false): string {
    const lines = [
      `Ticket ${ticket.id}. Work directory: ${ticket.directory}.`,
      `You are the worker for this ticket. Report progress with the superagent_report_ticket tool, using one of: progress, waiting, ready, blocked, failed, dropped.`,
      `Blocked means you need a person's decision: report blocked and stop.`,
      `Merging: Never enable auto-merge as the agent account; only for this ticket's pull request, when ready, approvals cover the head commit, and the diff is under 200 lines; withdraw auto-merge before pushing another revision.`,
    ]
    if (recovery) {
      lines.push(
        `The host restarted. Before repeating any outside action, check the work directory, the git history and the remote state.`,
      )
    }
    lines.push(``, `Inputs:`)
    lines.push(...(inputs.length > 0 ? inputs.map(text => `- ${text}`) : ['- (none; recover where you left off)']))
    return lines.join('\n')
  }

  private save(ticket: Ticket): Promise<void> {
    return this.kv.set(`ticket/${ticket.id}`, ticket)
  }

  private async load(ticketId: string): Promise<Ticket | undefined> {
    return this.live.get(ticketId) ?? this.kv.get<Ticket>(`ticket/${ticketId}`)
  }
}
