import { describe, expect, it } from 'vitest'
import { AssignmentSchema } from '../core/assignment.ts'
import { TicketSchema } from '../core/model.ts'

describe('assignment', () => {
  it('parses an assignment with pending status and transitions', () => {
    const assignment = AssignmentSchema.parse({
      id: 'asg_1',
      ticketId: 'tkt_1',
      status: 'pending',
      startedAt: 1,
    })
    expect(assignment.status).toBe('pending')
    const running = AssignmentSchema.parse({ ...assignment, status: 'running' })
    expect(running.status).toBe('running')
    const ended = AssignmentSchema.parse({ ...assignment, status: 'ended', endReason: 'host restarted', endedAt: 2 })
    expect(ended.endReason).toBe('host restarted')
    expect(() => AssignmentSchema.parse({ ...assignment, status: 'queued' })).toThrow()
  })

  it('an ended assignment must carry an end reason', () => {
    expect(() => AssignmentSchema.parse({ id: 'asg_1', ticketId: 'tkt_1', status: 'ended', startedAt: 1 })).toThrow()
  })

  it('a ticket carries its assignment ids', () => {
    const ticket = TicketSchema.parse({
      id: 'tkt_1',
      mandateId: 'man_1',
      status: 'open',
      subscriptions: [],
      reports: [],
      assignmentIds: ['asg_1'],
    })
    expect(ticket.assignmentIds).toEqual(['asg_1'])
  })
})
