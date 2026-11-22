import { describe, expect, it } from 'vitest'
import { assemble, type AssembleDeps, type ToolDefinition } from '../index.ts'
import type { SessionPort } from '../executor.ts'
import { memoryKV } from '../kv.ts'

const harness = () => {
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
  const tools: ToolDefinition[] = []
  const deps: AssembleDeps = {
    kv: memoryKV(),
    sessions: sessionPort,
    tools: { add: tool => tools.push(tool) },
    workerLimit: 3,
  }
  return { app: assemble(deps), sessions, tools, kv: deps.kv }
}

describe('assemble', () => {
  it('submit opens a ticket and dispatches a worker', async () => {
    const { app, sessions } = harness()
    await app.submit('s1', 'fix the flaky test')
    const tickets = await app.engine.tickets()
    expect(tickets).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sessions.created).toEqual([`worker-${tickets[0]!.id}`])
  })

  it('a #ticket reference routes to that ticket without opening new work', async () => {
    const { app } = harness()
    await app.submit('s1', 'fix the flaky test')
    const ticket = (await app.engine.tickets())[0]!
    const disposition = await app.submit('s1', `#${ticket.id} also update the changelog`)
    expect(disposition).toBe('fannedOut')
    expect(await app.engine.tickets()).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    const deliver = app.events.find(event => event.type === 'fanout')
    expect(deliver).toMatchObject({ type: 'fanout', ticketId: ticket.id })
  })

  it('an unknown #reference falls through to a new ticket', async () => {
    const { app } = harness()
    const disposition = await app.submit('s1', '#nope a fresh task')
    expect(disposition).toBe('evaluated')
    expect(await app.engine.tickets()).toHaveLength(1)
  })

  it('the same text resubmitted is the same trigger: no duplicate ticket', async () => {
    const { app } = harness()
    await app.submit('s1', 'fix the flaky test')
    await app.submit('s1', 'fix the flaky test')
    expect(await app.engine.tickets()).toHaveLength(1)
  })

  it('registers the report, list and stop tools', () => {
    const { tools } = harness()
    expect(tools.map(tool => tool.name)).toEqual([
      'superagent_report_ticket',
      'superagent_tickets',
      'superagent_stop_ticket',
    ])
  })

  it('the report tool enforces the worker-session boundary', async () => {
    const { app, tools } = harness()
    await app.submit('s1', 'fix the flaky test')
    const ticket = (await app.engine.tickets())[0]!
    await new Promise(resolve => setTimeout(resolve, 0))
    const report = tools.find(tool => tool.name === 'superagent_report_ticket')!
    const input = { ticket: ticket.id, kind: 'ready', text: 'done' }
    // A foreign session may not report on the ticket.
    await expect(report.execute(input, { sessionID: 's-foreign' })).rejects.toThrow(/not this ticket's worker/)
    // The ticket's own worker may.
    const workerSession = (await app.engine.tickets())[0]!.sessionId
    await expect(report.execute(input, { sessionID: workerSession })).resolves.toMatchObject({ content: 'reported ready' })
  })
})
