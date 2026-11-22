import type { KV } from './kv.ts'
import type { Report, Ticket } from './core.ts'

/**
 * lite版的 Executor：每个工单一个 worker session 和一个独立 worktree 目录，最多同时占用
 * `limit` 个槽位，超出的派工排队。工单状态由结构化 Report 驱动，Executor 只汇报事实。
 *
 * 相比完整版去掉：assignment 记录、outbox 重试、transient 判定、紧急槽位与 held 恢复台账。
 */

export interface SessionPort {
  create(title: string): Promise<{ sessionID: string }>
  prompt(sessionID: string, text: string): Promise<void>
  interrupt(sessionID: string): Promise<void>
}

export interface WorktreePort {
  create(name: string): Promise<{ directory: string }>
}

export interface ExecutorDeps {
  sessions: SessionPort
  worktrees?: WorktreePort
  kv: KV
  /** Concurrent worker slots. */
  limit?: number
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

export class LiteExecutor {
  private readonly sessions: SessionPort
  private readonly worktrees?: WorktreePort
  private readonly kv: KV
  private readonly slots: Semaphore
  /** In-memory view of tickets this executor launched; the KV copy is the durable truth. */
  private readonly live = new Map<string, Ticket>()
  private readonly held = new Set<string>()

  constructor(deps: ExecutorDeps) {
    this.sessions = deps.sessions
    this.worktrees = deps.worktrees
    this.kv = deps.kv
    this.slots = new Semaphore(deps.limit ?? 3)
  }

  /** Launches the ticket's worker: one session, one directory. Queues when slots are full. */
  async dispatch(ticket: Ticket, inputs: string[], recovery = false): Promise<void> {
    this.live.set(ticket.id, ticket)
    await this.slots.take()
    try {
      if (!ticket.directory && this.worktrees) {
        const { directory } = await this.worktrees.create(ticket.id)
        ticket.directory = directory
      }
      if (!ticket.sessionId) {
        const { sessionID } = await this.sessions.create(`worker-${ticket.id}`)
        ticket.sessionId = sessionID
      }
      await this.save(ticket)
      await this.sessions.prompt(ticket.sessionId, this.brief(ticket, inputs, recovery))
    } catch (error) {
      await this.report(ticket.id, { kind: 'failed', text: `launch failed: ${error instanceof Error ? error.message : String(error)}`, at: Date.now() })
    } finally {
      this.slots.release()
    }
  }

  /** Delivers a new input to a live worker. Refuses while the ticket waits for a person. */
  async deliver(ticketId: string, text: string): Promise<void> {
    if (this.held.has(ticketId)) throw new Error(`ticket ${ticketId} is held: waiting for a person`)
    const ticket = await this.load(ticketId)
    if (!ticket?.sessionId) throw new Error(`ticket ${ticketId} has no live worker`)
    await this.sessions.prompt(ticket.sessionId, text)
  }

  /** The report_ticket tool lands here. Only structured reports move the ticket. */
  async report(ticketId: string, report: Report): Promise<void> {
    const ticket = await this.load(ticketId)
    if (!ticket) throw new Error(`unknown ticket ${ticketId}`)
    ticket.reports.push(report)
    if (report.kind === 'ready') {
      ticket.status = 'ended'
      ticket.outcome = 'completed'
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

  /** A person's message reached a held ticket: it stops waiting. */
  onPersonMessage(ticketId: string): void {
    this.held.delete(ticketId)
  }

  /** Interrupts the worker and marks the ticket stopped; the engine has already ended it. */
  async stop(ticketId: string): Promise<void> {
    const ticket = await this.load(ticketId)
    this.held.delete(ticketId)
    if (ticket?.sessionId) await this.sessions.interrupt(ticket.sessionId)
  }

  /** A reload or restart loses the worker session: open tickets start again, with a recovery note. */
  async recover(): Promise<void> {
    const rows = await this.kv.scan('ticket/')
    for (const row of rows) {
      const ticket = row.value as Ticket
      if (ticket.status !== 'open') continue
      const last = ticket.reports.at(-1)
      if (last && (last.kind === 'blocked' || last.kind === 'failed')) this.held.add(ticket.id)
      ticket.sessionId = undefined
      this.live.set(ticket.id, ticket)
      await this.save(ticket)
      void this.dispatch(ticket, [], true).catch(() => {})
    }
  }

  private brief(ticket: Ticket, inputs: string[], recovery = false): string {
    const lines = [
      `Ticket ${ticket.id}${ticket.directory ? `. Work directory: ${ticket.directory}.` : '.'}`,
      `You are the worker for this ticket. Report progress with the superagent_report_ticket tool, using one of: progress, waiting, ready, blocked, failed, dropped.`,
      `Blocked means you need a person's decision: report blocked and stop.`,
    ]
    if (recovery) {
      lines.push(`The host restarted. Before repeating any action, check the work directory and the current state.`)
    }
    lines.push(``, `Task:`)
    lines.push(...(inputs.length > 0 ? inputs.map(text => `- ${text}`) : ['- (recover where you left off)']))
    return lines.join('\n')
  }

  private save(ticket: Ticket): Promise<void> {
    return this.kv.set(`ticket/${ticket.id}`, ticket)
  }

  private async load(ticketId: string): Promise<Ticket | undefined> {
    return this.live.get(ticketId) ?? this.kv.get<Ticket>(`ticket/${ticketId}`)
  }
}
