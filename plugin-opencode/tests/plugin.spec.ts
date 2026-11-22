import { describe, expect, it } from 'vitest'
import { assemble } from '../index.ts'
import type { ToolContext, ToolEditor } from '../index.ts'
import { MemoryKV } from '../core/kv.ts'
import type { SessionPort, WorktreePort } from '../core/executor.ts'

const fakeToolRegistry = () => {
  const registered: Array<{ name: string; execute: (input: unknown, context?: ToolContext) => Promise<unknown> }> = []
  const editor: ToolEditor = {
    namespace() {},
    add(tool) {
      registered.push({ name: tool.name, execute: tool.execute })
    },
    update() {},
    remove() {},
  }
  return { registered, editor }
}

const baseDeps = () => {
  const order: string[] = []
  const kv = MemoryKV()
  const prompts: { sessionID: string; text: string }[] = []
  const sessions: SessionPort & { prompts: { sessionID: string; text: string }[] } = {
    prompts,
    create: async title => {
      order.push(`create:${title}`)
      return { sessionID: `sess_${title}` }
    },
    prompt: async (sessionID, text) => { prompts.push({ sessionID, text }) },
    interrupt: async () => {},
  }
  const worktrees: WorktreePort = { create: async name => ({ directory: `D:/wt/${name}` }) }
  const recover = async () => { order.push('recover') }
  const poll = async () => { order.push('poll') }
  return { kv, sessions, worktrees, order, recover, poll }
}

describe('assemble', () => {
  it('registers the superagent_report_ticket tool that forwards to the executor', async () => {
    const deps = baseDeps()
    const { editor, registered } = fakeToolRegistry()
    const app = assemble({ ...deps, token: 'tok', tools: editor })
    expect(registered.map(t => t.name)).toContain('superagent_report_ticket')
    const tool = registered.find(t => t.name === 'superagent_report_ticket')!
    await expect(tool.execute({ ticket: 'nope', kind: 'ready', text: 'x' })).rejects.toThrow('unknown ticket')
    const ticket = { id: 'tkt_1', mandateId: 'man_1', status: 'open', subscriptions: [], reports: [], assignmentIds: [] }
    await deps.kv.set('ticket/tkt_1', ticket)
    await tool.execute({ ticket: 'tkt_1', kind: 'ready', text: 'done' })
    const stored = await deps.kv.get<{ status: string; outcome?: string }>('ticket/tkt_1')
    expect(stored).toMatchObject({ status: 'ended', outcome: 'completed' })
  })

  it('recovers the outbox before resuming dispatch, and cleanup stops the poller', async () => {
    const deps = baseDeps()
    const { editor } = fakeToolRegistry()
    const timers: (() => void)[] = []
    const app = assemble({
      ...deps,
      token: 'tok',
      tools: editor,
      recover: deps.recover,
      resumeDispatch: async () => { deps.order.push('resume') },
      setIntervalFn: (fn: () => void) => { timers.push(fn); return fn },
      clearIntervalFn: (fn: unknown) => {
        const index = timers.indexOf(fn as () => void)
        if (index >= 0) timers.splice(index, 1)
      },
    })
    await app.start()
    expect(deps.order[0]).toBe('recover')
    expect(deps.order).toContain('resume')
    expect(timers).toHaveLength(1)
    await app.cleanup()
    expect(timers).toHaveLength(0)
  })

  it('delivers fan-out and person messages through the outbox to the worker session', async () => {
    const deps = baseDeps()
    const { editor } = fakeToolRegistry()
    const app = assemble({ ...deps, token: 'tok', tools: editor })
    const ticket = { id: 'tkt_1', mandateId: 'man_1', status: 'open', subscriptions: [], reports: [], assignmentIds: [] }
    await deps.kv.set('ticket/tkt_1', ticket)
    await app.executor.dispatch(ticket as never, ['first'])
    // Fan-out: a later trigger on the thread reaches the live worker.
    await app.outbox.enqueue('deliver', { ticketId: 'tkt_1', inputs: ['also check the types'] })
    expect(deps.sessions.prompts.at(-1)?.text).toBe('also check the types')
    // A person's message releases a held ticket and delivers its text.
    await app.executor.report('tkt_1', { kind: 'blocked', text: 'need a decision', at: 1 })
    app.engine.onPersonMessage?.('tkt_1', 'use plan b')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(deps.sessions.prompts.at(-1)?.text).toBe('use plan b')
  })

  it('sends PR outcome notices to the origin channel through the outbox', async () => {
    const deps = baseDeps()
    const { editor } = fakeToolRegistry()
    const replies: Array<{ threadKey: string; text: string }> = []
    const app = assemble({
      ...deps, token: 'tok', tools: editor,
      channel: { reply: async (threadKey, text) => { replies.push({ threadKey, text }) } },
    })
    await app.outbox.enqueue('notice', { ticketId: 'tkt_1', text: 'pull request #42 merged; work complete.' })
    expect(replies).toHaveLength(0) // unknown ticket: nothing to send
    const ticket = { id: 'tkt_1', mandateId: 'man_1', status: 'open', subscriptions: ['github:a/b:1'], reports: [], assignmentIds: [] }
    await deps.kv.set('ticket/tkt_1', ticket)
    await app.outbox.enqueue('notice', { ticketId: 'tkt_1', text: 'pull request #42 merged; work complete.' })
    expect(replies).toEqual([{ threadKey: 'github:a/b:1', text: 'pull request #42 merged; work complete.' }])
  })

  it('validates report tool input and refuses a report from a foreign session', async () => {
    const deps = baseDeps()
    const { editor, registered } = fakeToolRegistry()
    const app = assemble({ ...deps, token: 'tok', tools: editor })
    const tool = registered.find(t => t.name === 'superagent_report_ticket')!
    const ticket = { id: 'tkt_1', mandateId: 'man_1', status: 'open', sessionId: 'sess_worker-tkt_1', subscriptions: [], reports: [] }
    await deps.kv.set('ticket/tkt_1', ticket)
    await expect(tool.execute({ ticket: 'tkt_1', kind: 'finished', text: 'x' })).rejects.toThrow()
    await expect(tool.execute({ ticket: 'tkt_1', kind: 'ready', text: 'x' }, { sessionID: 'sess_other' })).rejects.toThrow('not this ticket')
    await tool.execute({ ticket: 'tkt_1', kind: 'ready', text: 'x' }, { sessionID: 'sess_worker-tkt_1' })
    expect(app.engine).toBeDefined()
  })

  it('sends recovery notes to open tickets with running assignments on start, oldest first', async () => {
    const deps = baseDeps()
    const { editor } = fakeToolRegistry()
    const makeTicket = (id: string) => ({
      id, mandateId: 'man_1', status: 'open', subscriptions: [], reports: [], assignmentIds: [`asg_${id}`], sessionId: `sess_worker-${id}`,
    })
    await deps.kv.set('ticket/tkt_2', makeTicket('tkt_2'))
    await deps.kv.set('ticket/tkt_1', makeTicket('tkt_1'))
    await deps.kv.set('assignment/asg_tkt_1', { id: 'asg_tkt_1', ticketId: 'tkt_1', status: 'running', startedAt: 1 })
    await deps.kv.set('assignment/asg_tkt_2', { id: 'asg_tkt_2', ticketId: 'tkt_2', status: 'running', startedAt: 2 })
    const app = assemble({ ...deps, token: 'tok', tools: editor })
    await app.start()
    const creates = deps.order.filter(entry => entry.startsWith('create:'))
    expect(creates.indexOf('create:worker-tkt_1')).toBeLessThan(creates.indexOf('create:worker-tkt_2'))
    const asg1 = await deps.kv.get<{ status: string; endReason?: string }>('assignment/asg_tkt_1')
    expect(asg1).toMatchObject({ status: 'ended', endReason: 'host restarted' })
    const note = deps.sessions.prompts.find(p => p.text.includes('Ticket tkt_1') && p.text.includes('restart'))!
    expect(note.text).toContain('git')
  })

  it('retries pending triggers left over from an unavailable eval on start', async () => {
    const deps = baseDeps()
    const { editor } = fakeToolRegistry()
    await deps.kv.set('pending/github:a/b:1', [{ id: 'trg_p1', source: 'github', actor: { id: 'zephyrbd', bot: false }, text: 'queued', url: 'u', at: 1, threadKey: 'github:a/b:1' }])
    await deps.kv.set('disposition/trg_p1', 'evaluated')
    const app = assemble({
      ...deps, token: 'tok', tools: editor,
      config: { repository: 'a/b', allowedActors: ['zephyrbd'] },
      generate: { text: async () => ({ text: '{"kind":"accept","scope":"queued work"}' }) },
    })
    await app.start()
    expect(await app.engine.tickets()).toHaveLength(1)
  })
})
