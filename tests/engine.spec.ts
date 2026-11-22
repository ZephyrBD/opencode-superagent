import { describe, expect, it } from 'vitest'
import { Engine } from '../core/engine.ts'
import { MemoryKV } from '../core/kv.ts'
import { policy as makePolicy } from './policy.spec.ts'
import type { Assessor, ThreadState } from '../core/engine.ts'
import type { Decision, Trigger } from '../core/model.ts'

const fakeAssessor = (script: Array<(input: { batch: Trigger[]; thread: ThreadState }) => Decision>): Assessor & { calls: { batch: Trigger[]; thread: ThreadState }[] } => {
  const calls: { batch: Trigger[]; thread: ThreadState }[] = []
  let step = 0
  return {
    calls,
    async assess(input) {
      calls.push(input)
      const next = script[step]
      step += 1
      if (!next) throw new Error('script exhausted')
      return next(input)
    },
  }
}

const trigger = (over: Partial<Trigger> = {}): Trigger => ({
  id: 'trg_1',
  source: 'github',
  actor: { id: 'zephyrbd', bot: false },
  text: 'fix this',
  url: 'u',
  at: 1,
  threadKey: 'github:a/b:1',
  ...over,
})

const setup = (assessor: Assessor) => {
  const kv = MemoryKV()
  const events: unknown[] = []
  const engine = new Engine({ kv, policy: makePolicy(), assessor, clock: () => 1, notify: e => events.push(e) })
  return { engine, kv, events }
}

describe('engine intake', () => {
  it('accepts a trigger and creates a ticket with a mandate', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 'fix this' })])
    const { engine } = setup(assessor)
    const result = await engine.intake(trigger())
    expect(result).toBe('evaluated')
    const tickets = await engine.tickets()
    expect(tickets).toHaveLength(1)
    expect(tickets[0]!.status).toBe('open')
    expect(tickets[0]!.subscriptions).toContain('github:a/b:1')
    expect(await engine.mandateOf(tickets[0]!.id)).toMatchObject({ policyVersion: 'p1', strength: 'explicit', scope: 'fix this' })
    expect(assessor.calls[0]!.thread.triggers).toHaveLength(1)
  })

  it('is idempotent on a replayed trigger', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 's' })])
    const { engine } = setup(assessor)
    await engine.intake(trigger())
    const result = await engine.intake(trigger())
    expect(result).toBe('filtered')
    expect((await engine.tickets())).toHaveLength(1)
    expect(assessor.calls).toHaveLength(1)
  })

  it('records without evaluating while paused', async () => {
    const assessor = fakeAssessor([])
    const { engine } = setup(assessor)
    engine.policy.paused = true
    expect(await engine.intake(trigger())).toBe('recorded')
    expect(assessor.calls).toHaveLength(0)
    expect(await engine.tickets()).toHaveLength(0)
  })

  it('does not deliver to a live ticket while paused', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 's' })])
    const { engine, events } = setup(assessor)
    await engine.intake(trigger())
    engine.policy.paused = true
    const personMessage = trigger({ id: 'trg_2', text: 'one more thing' })
    expect(await engine.intake(personMessage)).toBe('recorded')
    expect(events.filter(e => (e as { type: string }).type === 'fanout')).toHaveLength(0)
  })

  it('fans later thread triggers out to the live ticket without a new eval', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 's' })])
    const { engine, events } = setup(assessor)
    await engine.intake(trigger())
    const later = trigger({ id: 'trg_2', text: 'actually also check the types' })
    expect(await engine.intake(later)).toBe('fannedOut')
    expect(assessor.calls).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'fanout', ticketId: expect.any(String), trigger: later }))
  })

  it('ignores bot triggers once a ticket is live only for new evals, but fan-out skips bots too', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 's' })])
    const { engine } = setup(assessor)
    await engine.intake(trigger())
    expect(await engine.intake(trigger({ id: 'trg_3', actor: { id: 'ci-bot', bot: true } }))).toBe('filtered')
  })

  it('hands a follow-up back to Eval when the assessor rules it out of scope', async () => {
    const assessor = fakeAssessor([
      () => ({ kind: 'accept', scope: 's' }),
      () => ({ kind: 'accept', scope: 'different work' }),
    ])
    const scoped = assessor as typeof assessor & {
      classifyFollowUp?: (input: { trigger: Trigger; thread: ThreadState }) => Promise<{ inScope: boolean }>
    }
    scoped.classifyFollowUp = async ({ trigger: t }) => ({ inScope: t.id === 'trg_1' })
    const { engine, events } = setup(scoped)
    await engine.intake(trigger())
    const other = trigger({ id: 'trg_5', text: 'also migrate the database' })
    expect(await engine.intake(other)).toBe('evaluated')
    expect((await engine.tickets())).toHaveLength(2)
    expect(events.filter(e => (e as { type: string }).type === 'fanout')).toHaveLength(0)
  })

  it('fans an in-scope follow-up out without an extra eval', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 's' })])
    const scoped = assessor as typeof assessor & {
      classifyFollowUp?: (input: { trigger: Trigger; thread: ThreadState }) => Promise<{ inScope: boolean }>
    }
    scoped.classifyFollowUp = async () => ({ inScope: true })
    const { engine, events } = setup(assessor)
    await engine.intake(trigger())
    expect(await engine.intake(trigger({ id: 'trg_6', text: 'also update the docs' }))).toBe('fannedOut')
    expect((await engine.tickets())).toHaveLength(1)
    expect(events.filter(e => (e as { type: string }).type === 'fanout')).toHaveLength(1)
  })

  it('queues a trigger when the assessor fails and retries it later', async () => {
    const assessor = fakeAssessor([
      () => { throw new Error('model down') },
      () => ({ kind: 'accept', scope: 's' }),
    ])
    const { engine } = setup(assessor)
    expect(await engine.intake(trigger())).toBe('evaluated')
    expect(await engine.tickets()).toHaveLength(0)
    await engine.retryPending('github:a/b:1')
    expect(await engine.tickets()).toHaveLength(1)
  })

  it('records an unavailable decision when the assessor gives no verdict, and retries later', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'unavailable' }), () => ({ kind: 'accept', scope: 's' })])
    const { engine } = setup(assessor)
    expect(await engine.intake(trigger())).toBe('evaluated')
    expect(await engine.tickets()).toHaveLength(0)
    const thread = await engine.thread('github:a/b:1')
    expect(thread?.decisions.at(-1)?.kind).toBe('unavailable')
    await engine.retryPending('github:a/b:1')
    expect(await engine.tickets()).toHaveLength(1)
    expect(assessor.calls).toHaveLength(2)
  })
})

describe('engine ticket lifecycle', () => {
  const accepted = async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 's' })])
    const { engine } = setup(assessor)
    await engine.intake(trigger())
    const ticket = (await engine.tickets())[0]!
    return { engine, ticket }
  }

  it('resumes an ended ticket on a person message under a holding mandate', async () => {
    const { engine, ticket } = await accepted()
    await engine.endTicket(ticket.id, 'completed')
    const events: unknown[] = []
    const engine2 = engine
    engine2.onPersonMessage = (ticketId, text) => { events.push([ticketId, text]) }
    expect(await engine2.intake(trigger({ id: 'trg_9', text: 'one more thing' }))).toBe('fannedOut')
    expect((await engine.tickets())[0]!.status).toBe('open')
    expect(events).toEqual([[ticket.id, 'one more thing']])
  })

  it('does not resume a ticket a person stopped, though a fresh request still evaluates', async () => {
    const { engine, ticket } = await accepted()
    const resumed: unknown[] = []
    engine.onPersonMessage = (ticketId, text) => resumed.push([ticketId, text])
    await engine.stop(ticket.id)
    expect(await engine.intake(trigger({ id: 'trg_9' }))).toBe('evaluated')
    expect(resumed).toEqual([])
    expect((await engine.tickets()).find(t => t.id === ticket.id)).toMatchObject({ status: 'ended', outcome: 'stopped' })
  })

  it('dispatches a new ticket through the notify port when accepted', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 'fix it' })])
    const { engine, events } = setup(assessor)
    await engine.intake(trigger())
    expect(events).toContainEqual(expect.objectContaining({ type: 'dispatch', ticketId: expect.any(String) }))
  })

  it('queues an out-of-scope follow-up when its eval is unavailable instead of losing it', async () => {
    const assessor = fakeAssessor([
      () => ({ kind: 'accept', scope: 's' }),
      () => ({ kind: 'unavailable' }),
      () => ({ kind: 'accept', scope: 'the other work' }),
    ])
    const scoped = assessor as typeof assessor & {
      classifyFollowUp?: (input: { trigger: Trigger; thread: ThreadState }) => Promise<{ inScope: boolean }>
    }
    scoped.classifyFollowUp = async ({ trigger: t }) => ({ inScope: t.id === 'trg_1' })
    const { engine } = setup(scoped)
    await engine.intake(trigger())
    expect(await engine.intake(trigger({ id: 'trg_5' }))).toBe('evaluated')
    expect((await engine.tickets())).toHaveLength(1)
    await engine.retryPending('github:a/b:1')
    expect((await engine.tickets())).toHaveLength(2)
  })

  it('routes follow-ups to the newest live ticket on the thread', async () => {
    const assessor = fakeAssessor([
      () => ({ kind: 'accept', scope: 'first' }),
      () => ({ kind: 'accept', scope: 'second' }),
    ])
    const scoped = assessor as typeof assessor & {
      classifyFollowUp?: (input: { trigger: Trigger; thread: ThreadState }) => Promise<{ inScope: boolean }>
    }
    scoped.classifyFollowUp = async ({ trigger: t }) => ({ inScope: t.id !== 'trg_5' })
    const { engine, events } = setup(scoped)
    await engine.intake(trigger())
    await engine.intake(trigger({ id: 'trg_5', text: 'different work' }))
    const tickets = await engine.tickets()
    await engine.intake(trigger({ id: 'trg_9', text: 'a correction' }))
    const fanout = events.filter(e => (e as { type: string }).type === 'fanout').at(-1) as { ticketId: string }
    expect(fanout.ticketId).toBe(tickets.at(-1)!.id)
  })

  it('ends a ticket as dropped when a ready report follows an unmerged PR close', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 's' })])
    const { engine } = setup(assessor)
    await engine.intake(trigger())
    const ticket = (await engine.tickets())[0]!
    await engine.followPr(ticket.id, 9)
    await engine.prClosed(ticket.id, 9, false)
    await engine.reportExternal(ticket.id, { kind: 'ready', text: 'done', at: 3 })
    expect((await engine.tickets())[0]).toMatchObject({ status: 'ended', outcome: 'dropped' })
  })

  it('stop marks the outcome and ends the ticket', async () => {
    const { engine, ticket } = await accepted()
    await engine.stop(ticket.id)
    expect((await engine.tickets())[0]).toMatchObject({ status: 'ended', outcome: 'stopped' })
  })

  it('follows a pull request and ends the ticket only when it closes after a ready report', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 's' })])
    const { engine, events } = setup(assessor)
    await engine.intake(trigger())
    const ticket = (await engine.tickets())[0]!
    await engine.followPr(ticket.id, 42)
    const followed = await engine.followedPrs(ticket.id)
    expect(followed).toEqual([{ number: 42, open: true }])
    expect(ticket.subscriptions).toContain('github:a/b:pr:42')

    // PR still open: a ready report waits for review instead of ending.
    await engine.reportExternal(ticket.id, { kind: 'ready', text: 'PR open', at: 2 })
    expect((await engine.tickets())[0]!.status).toBe('open')

    await engine.prClosed(ticket.id, 42, true)
    expect((await engine.tickets())[0]).toMatchObject({ status: 'ended', outcome: 'completed' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', ticketId: ticket.id }))
  })

  it('ends a ticket whose followed PR closed without merge as dropped', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 's' })])
    const { engine } = setup(assessor)
    await engine.intake(trigger())
    const ticket = (await engine.tickets())[0]!
    await engine.followPr(ticket.id, 7)
    await engine.reportExternal(ticket.id, { kind: 'ready', text: 'ready', at: 2 })
    await engine.prClosed(ticket.id, 7, false)
    expect((await engine.tickets())[0]).toMatchObject({ status: 'ended', outcome: 'dropped' })
  })

  it('keeps a ticket open while another followed PR stays open', async () => {
    const assessor = fakeAssessor([() => ({ kind: 'accept', scope: 's' })])
    const { engine } = setup(assessor)
    await engine.intake(trigger())
    const ticket = (await engine.tickets())[0]!
    await engine.followPr(ticket.id, 1)
    await engine.followPr(ticket.id, 2)
    await engine.prClosed(ticket.id, 1, true)
    expect((await engine.tickets())[0]!.status).toBe('open')
  })
})
