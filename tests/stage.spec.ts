import { describe, expect, it } from 'vitest'
import { stageOf } from '../core/stage.ts'
import type { Assignment } from '../core/assignment.ts'
import type { Ticket } from '../core/model.ts'

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tkt_1',
  mandateId: 'man_1',
  status: 'open',
  subscriptions: [],
  reports: [],
  assignmentIds: [],
  ...over,
})

const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  id: 'asg_1',
  ticketId: 'tkt_1',
  status: 'running',
  startedAt: 1,
  ...over,
})

describe('stage derivation', () => {
  it('delivery failure wins first', () => {
    const t = ticket({ deliveryFailed: true } as never)
    expect(stageOf(t, [assignment()], false)).toBe('person/delivery')
  })

  it('an attention question waits for a person', () => {
    const t = ticket({ attention: { question: 'which plan?' } } as never)
    expect(stageOf(t, [assignment()], false)).toBe('person/answer')
  })

  it('a ready report awaits review', () => {
    const t = ticket({ reports: [{ kind: 'ready', text: 'done', at: 1 }] })
    expect(stageOf(t, [assignment()], false)).toBe('person/review')
  })

  it('blocked and failed wait for a person until a person message arrives', () => {
    const blocked = ticket({ reports: [{ kind: 'blocked', text: 'need a decision', at: 1 }] })
    expect(stageOf(blocked, [assignment()], false)).toBe('person/blocked')
    expect(stageOf(blocked, [assignment()], true)).toBe('working')
    const failed = ticket({ reports: [{ kind: 'failed', text: 'boom', at: 1 }] })
    expect(stageOf(failed, [assignment()], false)).toBe('person/failed')
  })

  it('no assignment or a pending one queues', () => {
    expect(stageOf(ticket(), [], false)).toBe('working/queued')
    expect(stageOf(ticket(), [assignment({ status: 'pending' })], false)).toBe('working/queued')
  })

  it('waiting report or an ended assignment idles', () => {
    const waiting = ticket({ reports: [{ kind: 'waiting', text: 'idle', at: 1 }] })
    expect(stageOf(waiting, [assignment()], false)).toBe('idle')
    expect(stageOf(ticket(), [assignment({ status: 'ended', endReason: 'done', startedAt: 1, endedAt: 2 })], false)).toBe('idle')
  })

  it('everything else is working', () => {
    const t = ticket({ reports: [{ kind: 'progress', text: 'on it', at: 1 }] })
    expect(stageOf(t, [assignment()], false)).toBe('working')
  })
})
