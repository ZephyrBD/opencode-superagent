import { describe, expect, it } from 'vitest'
import { Executor } from '../core/executor.ts'
import type { SessionPort, WorktreePort } from '../core/executor.ts'
import { MemoryKV } from '../core/kv.ts'
import type { Assignment } from '../core/assignment.ts'
import type { Ticket } from '../core/model.ts'

const assignmentsOf = async (kv: ReturnType<typeof MemoryKV>): Promise<Assignment[]> =>
  (await kv.scan('assignment/')).map(row => row.value as Assignment)

const fakeSessions = (): SessionPort & { prompts: { sessionID: string; text: string }[]; created: number } => {
  const prompts: { sessionID: string; text: string }[] = []
  let n = 0
  return {
    prompts,
    created: 0,
    async create(title: string) {
      n += 1
      return { sessionID: `sess_${title}_${n}` }
    },
    async prompt(sessionID: string, text: string) {
      prompts.push({ sessionID, text })
    },
    async interrupt() {},
  }
}

const fakeWorktrees = (): WorktreePort & { created: string[] } => {
  const created: string[] = []
  return {
    created,
    async create(name: string) {
      created.push(name)
      return { directory: `D:/wt/${name}` }
    },
  }
}

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tkt_1',
  mandateId: 'man_1',
  status: 'open',
  subscriptions: [],
  reports: [],
  assignmentIds: [],
  ...over,
})

describe('executor', () => {
  it('re-delivers unread inputs on a new assignment and stops after a report confirms them', async () => {
    const kv = MemoryKV()
    const sessions = fakeSessions()
    const executor = new Executor({ sessions, worktrees: fakeWorktrees(), kv, limit: 2 })
    const t = ticket()
    await executor.dispatch(t, ['first'])
    await executor.deliver(t.id, 'unread follow-up')
    // No report yet: the message is unconfirmed, so a replacement assignment carries it again.
    await executor.dispatch(t, ['second'])
    const last = sessions.prompts.at(-1)!.text
    expect(last).toContain('unread follow-up')
    expect(last).toContain('second')
    // A report confirms delivery: the next assignment starts clean.
    await executor.report(t.id, { kind: 'progress', text: 'got it', at: 3 })
    await executor.dispatch(t, ['third'])
    expect(sessions.prompts.at(-1)!.text).not.toContain('unread follow-up')
  })

  it('retries transient launch failures with backoff and fails the ticket on a persistent one', async () => {
    const kv = MemoryKV()
    let attempts = 0
    const flaky: SessionPort = {
      create: async () => ({ sessionID: 'sess_x' }),
      prompt: async () => {
        attempts += 1
        if (attempts <= 2) throw new Error('fetch failed: ECONNRESET')
      },
      interrupt: async () => {},
    }
    const executor = new Executor({ sessions: flaky, worktrees: fakeWorktrees(), kv, limit: 2, delay: async () => {} })
    const t = ticket()
    await executor.dispatch(t, ['x'])
    expect(attempts).toBe(3)

    const persistent: SessionPort = {
      create: async () => ({ sessionID: 'sess_y' }),
      prompt: async () => { throw new Error('HTTP 404 from github') },
      interrupt: async () => {},
    }
    const executor2 = new Executor({ sessions: persistent, worktrees: fakeWorktrees(), kv, limit: 2, delay: async () => {} })
    const t2 = ticket({ id: 'tkt_2' })
    await executor2.dispatch(t2, ['x'])
    expect(t2.reports.at(-1)?.kind).toBe('failed')
  })

  it('creates an assignment per dispatch and ends it with a reason', async () => {
    const kv = MemoryKV()
    const executor = new Executor({ sessions: fakeSessions(), worktrees: fakeWorktrees(), kv, limit: 2 })
    const t = ticket()
    await executor.dispatch(t, ['first'])
    let rows = await assignmentsOf(kv)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ticketId: 'tkt_1', status: 'running' })
    expect(t.assignmentIds).toHaveLength(1)
    const [first] = rows
    await executor.endAssignment(first!.id, 'replaced')
    rows = await assignmentsOf(kv)
    expect(rows[0]).toMatchObject({ status: 'ended', endReason: 'replaced' })
    await executor.dispatch(t, ['second'])
    rows = await assignmentsOf(kv)
    expect(rows).toHaveLength(2)
    expect(t.assignmentIds).toHaveLength(2)
  })

  it('dispatches a ticket into a new worktree and worker session with a briefing prompt', async () => {
    const sessions = fakeSessions()
    const worktrees = fakeWorktrees()
    const executor = new Executor({ sessions, worktrees, kv: MemoryKV(), limit: 2 })
    const t = ticket()
    await executor.dispatch(t, ['fix the flaky test'])
    expect(worktrees.created).toEqual(['tkt_1'])
    expect(t.directory).toBe('D:/wt/tkt_1')
    expect(t.sessionId).toBe('sess_worker-tkt_1_1')
    const first = sessions.prompts[0]!
    expect(first.sessionID).toBe('sess_worker-tkt_1_1')
    expect(first.text).toContain('D:/wt/tkt_1')
    expect(first.text).toContain('fix the flaky test')
  })

  it('reuses the session and directory on a later dispatch', async () => {
    const sessions = fakeSessions()
    const worktrees = fakeWorktrees()
    const executor = new Executor({ sessions, worktrees, kv: MemoryKV(), limit: 2 })
    const t = ticket()
    await executor.dispatch(t, ['first'])
    await executor.dispatch(t, ['second'])
    expect(worktrees.created).toHaveLength(1)
    expect(t.sessionId).toBe('sess_worker-tkt_1_1')
    expect(sessions.prompts).toHaveLength(2)
  })

  it('a ready report ends the ticket as completed', async () => {
    const executor = new Executor({ sessions: fakeSessions(), worktrees: fakeWorktrees(), kv: MemoryKV(), limit: 2 })
    const t = ticket()
    await executor.dispatch(t, ['x'])
    await executor.report(t.id, { kind: 'ready', text: 'done, PR open', at: 1 })
    expect(t).toMatchObject({ status: 'ended', outcome: 'completed' })
    expect(t.reports.at(-1)?.kind).toBe('ready')
  })

  it('a dropped report ends the ticket without a fuss', async () => {
    const executor = new Executor({ sessions: fakeSessions(), worktrees: fakeWorktrees(), kv: MemoryKV(), limit: 2 })
    const t = ticket()
    await executor.dispatch(t, ['x'])
    await executor.report(t.id, { kind: 'dropped', text: 'cannot reproduce', at: 1 })
    expect(t).toMatchObject({ status: 'ended', outcome: 'dropped' })
  })

  it('rebuilds the held set from durable reports, so a reload keeps blocked tickets held', async () => {
    const kv = MemoryKV()
    await kv.set('ticket/tkt_h', { id: 'tkt_h', mandateId: 'man_1', status: 'open', sessionId: 'sess_h', subscriptions: [], reports: [{ kind: 'blocked', text: 'waiting', at: 1 }] })
    const executor = new Executor({ sessions: fakeSessions(), worktrees: fakeWorktrees(), kv, limit: 2 })
    await executor.rebuild()
    await expect(executor.deliver('tkt_h', 'hello')).rejects.toThrow()
  })

  it('holds delivery after blocked and releases it on a person message', async () => {
    const sessions = fakeSessions()
    const executor = new Executor({ sessions, worktrees: fakeWorktrees(), kv: MemoryKV(), limit: 2 })
    const t = ticket()
    await executor.dispatch(t, ['x'])
    await executor.report(t.id, { kind: 'blocked', text: 'need a decision', at: 2 })
    await expect(executor.deliver(t.id, 'use plan b')).rejects.toThrow()
    executor.onPersonMessage(t.id)
    await executor.deliver(t.id, 'use plan b')
    expect(sessions.prompts.at(-1)?.text).toBe('use plan b')
  })

  it('queues launches past the limit and drains when a slot frees', async () => {
    const gates: Array<() => void> = []
    const sessions: SessionPort = {
      async create(title) {
        return { sessionID: `sess_${title}` }
      },
      prompt(_sessionID, _text) {
        return new Promise<void>(resolve => gates.push(resolve))
      },
      async interrupt() {},
    }
    const executor = new Executor({ sessions, worktrees: fakeWorktrees(), kv: MemoryKV(), limit: 2 })
    const a = ticket({ id: 'tkt_a' })
    const b = ticket({ id: 'tkt_b' })
    const c = ticket({ id: 'tkt_c' })
    const pa = executor.dispatch(a, ['1'])
    const pb = executor.dispatch(b, ['2'])
    await new Promise(resolve => setTimeout(resolve, 10))
    const pc = executor.dispatch(c, ['3'])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(c.sessionId).toBeUndefined()
    gates[0]!()
    await pa
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(c.sessionId).toBe('sess_worker-tkt_c')
    gates[2]!()
    await pc
    gates[1]!()
    await pb
  })
})
