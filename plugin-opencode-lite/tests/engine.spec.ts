import { describe, expect, it } from 'vitest'
import { LiteEngine, type EngineEvent, type Ticket, type Trigger } from '../core.ts'
import { LiteExecutor, type SessionPort } from '../executor.ts'
import { memoryKV } from '../kv.ts'

const makeTrigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: 'tr1',
  source: 'session',
  actorId: 'operator',
  text: 'fix the flaky test',
  threadKey: 'session:s1',
  at: 1000,
  ...overrides,
})

interface Harness {
  kv: ReturnType<typeof memoryKV>
  engine: LiteEngine
  executor: LiteExecutor
  events: EngineEvent[]
  sessions: { created: string[]; prompted: Array<{ sessionID: string; text: string }>; interrupted: string[] }
}

const harness = (limit?: number): Harness => {
  const kv = memoryKV()
  const events: EngineEvent[] = []
  let ticketSeq = 0
  let mandateSeq = 0
  let decisionSeq = 0
  const engine = new LiteEngine({
    kv,
    clock: () => 1000,
    newTicketId: () => `t${++ticketSeq}`,
    newMandateId: () => `m${++mandateSeq}`,
    newDecisionId: () => `d${++decisionSeq}`,
    notify: event => events.push(event),
  })
  const sessions = {
    created: [] as string[],
    prompted: [] as Array<{ sessionID: string; text: string }>,
    interrupted: [] as string[],
  }
  const sessionPort: SessionPort = {
    create: async title => {
      sessions.created.push(title)
      return { sessionID: `s-${title}` }
    },
    prompt: async (sessionID, text) => {
      sessions.prompted.push({ sessionID, text })
    },
    interrupt: async sessionID => {
      sessions.interrupted.push(sessionID)
    },
  }
  const executor = new LiteExecutor({ sessions: sessionPort, kv, limit })
  return { kv, engine, executor, events, sessions }
}

describe('LiteEngine', () => {
  it('accepts an explicit message: mandate, ticket and decision are created atomically', async () => {
    const { engine, kv, events } = harness()
    const disposition = await engine.intake(makeTrigger())
    expect(disposition).toBe('evaluated')
    const tickets = await engine.tickets()
    expect(tickets).toHaveLength(1)
    const ticket = tickets[0]!
    expect(ticket.status).toBe('open')
    expect(ticket.subscriptions).toEqual(['session:s1'])
    const mandate = await engine.mandateOf(ticket.id)
    expect(mandate).toMatchObject({ strength: 'explicit', actorId: 'operator', scope: 'fix the flaky test', via: 'session' })
    const decisions = await kv.scan('decision/')
    expect(decisions).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'accept', ticket: { id: ticket.id } })
    const thread = await engine.thread('session:s1')
    expect(thread?.ticketIds).toEqual([ticket.id])
  })

  it('is idempotent: the same trigger never opens work twice', async () => {
    const { engine } = harness()
    const first = await engine.intake(makeTrigger())
    const second = await engine.intake(makeTrigger())
    expect(first).toBe('evaluated')
    expect(second).toBe('filtered')
    expect(await engine.tickets()).toHaveLength(1)
  })

  it('fans a follow-up on the thread out to the live ticket without an eval', async () => {
    const { engine, events } = harness()
    const accept = await engine.intake(makeTrigger())
    expect(accept).toBe('evaluated')
    const ticketId = (await engine.tickets())[0]!.id
    const disposition = await engine.intake(makeTrigger({ id: 'tr2', text: 'also update the changelog' }))
    expect(disposition).toBe('fannedOut')
    expect(events.at(-1)).toMatchObject({ type: 'fanout', ticketId, text: 'also update the changelog' })
    expect(await engine.tickets()).toHaveLength(1)
  })

  it('a person message on the thread resumes an ended ticket under the same mandate', async () => {
    const { engine, executor, kv, events } = harness()
    await engine.intake(makeTrigger())
    const ticket = (await engine.tickets())[0]!
    await executor.report(ticket.id, { kind: 'ready', text: 'done', at: 2000 })
    const ended = (await engine.tickets())[0]!
    expect(ended.status).toBe('ended')
    const disposition = await engine.followUp(ended.id, makeTrigger({ id: 'tr2', text: 'one more fix' }))
    expect(disposition).toBe('fannedOut')
    const resumed = await kv.get<Ticket>(`ticket/${ended.id}`)
    expect(resumed?.status).toBe('open')
    expect(resumed?.mandateId).toBe(ended.mandateId)
    expect(events.at(-1)).toMatchObject({ type: 'resume', ticketId: ended.id })
  })

  it('a stopped ticket may not be resumed', async () => {
    const { engine, kv } = harness()
    await engine.intake(makeTrigger())
    const ticket = (await engine.tickets())[0]!
    await engine.stop(ticket.id)
    const disposition = await engine.followUp(ticket.id, makeTrigger({ id: 'tr2', text: 'try again' }))
    expect(disposition).toBe('filtered')
    const stopped = await kv.get<Ticket>(`ticket/${ticket.id}`)
    expect(stopped?.outcome).toBe('stopped')
  })

  it('serializes evals on one thread: the second concurrent trigger fans out instead of opening work', async () => {
    const { engine } = harness()
    const results = await Promise.all([
      engine.intake(makeTrigger({ id: 'trA', threadKey: 'session:s1' })),
      engine.intake(makeTrigger({ id: 'trB', threadKey: 'session:s1' })),
    ])
    expect(results).toEqual(['evaluated', 'fannedOut'])
    expect(await engine.tickets()).toHaveLength(1)
  })
})

describe('LiteExecutor', () => {
  it('dispatches one worker session per ticket with a briefing', async () => {
    const { engine, executor, sessions } = harness()
    await engine.intake(makeTrigger())
    const ticket = (await engine.tickets())[0]!
    await executor.dispatch(ticket, ['fix the flaky test'])
    expect(sessions.created).toEqual([`worker-${ticket.id}`])
    expect(sessions.prompted).toHaveLength(1)
    expect(sessions.prompted[0]!.text).toContain(`Ticket ${ticket.id}`)
    expect(sessions.prompted[0]!.text).toContain('fix the flaky test')
  })

  it('queues launches beyond the worker limit', async () => {
    const { engine, executor, sessions } = harness(1)
    await engine.intake(makeTrigger())
    await engine.intake(makeTrigger({ id: 'tr2', text: 'second task', threadKey: 'session:s2' }))
    const tickets = await engine.tickets()
    expect(tickets).toHaveLength(2)
    // Both launches start without awaiting; only one session exists until the first releases its slot.
    const launches = tickets.map(ticket => executor.dispatch(ticket, [ticket.id]))
    await Promise.all(launches)
    expect(sessions.created).toHaveLength(2)
  })

  it('a ready report ends the ticket; blocked holds further deliveries', async () => {
    const { engine, executor, kv, sessions } = harness()
    await engine.intake(makeTrigger())
    const ticket = (await engine.tickets())[0]!
    await executor.dispatch(ticket, ['fix the flaky test'])
    const stored = await kv.get<Ticket>(`ticket/${ticket.id}`)
    await executor.report(ticket.id, { kind: 'blocked', text: 'which branch?', at: 2000 })
    let current = await kv.get<Ticket>(`ticket/${ticket.id}`)
    expect(current?.attention?.question).toBe('which branch?')
    await expect(executor.deliver(ticket.id, 'main')).rejects.toThrow(/held/)
    executor.onPersonMessage(ticket.id)
    await executor.report(ticket.id, { kind: 'progress', text: 'on main', at: 3000 })
    await executor.deliver(ticket.id, 'target main')
    expect(sessions.prompted.some(entry => entry.sessionID === stored!.sessionId && entry.text === 'target main')).toBe(true)
    await executor.report(ticket.id, { kind: 'ready', text: 'done', at: 4000 })
    current = await kv.get<Ticket>(`ticket/${ticket.id}`)
    expect(current?.status).toBe('ended')
    expect(current?.outcome).toBe('completed')
  })

  it('stop interrupts the worker session', async () => {
    const { engine, executor, kv, sessions } = harness()
    await engine.intake(makeTrigger())
    const ticket = (await engine.tickets())[0]!
    await executor.dispatch(ticket, ['fix the flaky test'])
    const stored = await kv.get<Ticket>(`ticket/${ticket.id}`)
    await executor.stop(ticket.id)
    expect(sessions.interrupted).toEqual([stored!.sessionId])
  })
})
