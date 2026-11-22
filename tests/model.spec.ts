import { describe, expect, it } from 'vitest'
import { MandateSchema, ReportSchema, TicketSchema, TriggerSchema } from '../core/model.ts'
import { newTicketId, newTriggerId } from '../core/ids.ts'

describe('domain model', () => {
  const trigger = {
    id: 'trg_01',
    source: 'github',
    actor: { id: 'zephyrbd', bot: false },
    text: 'please fix the flaky test',
    url: 'https://github.com/a/b/issues/1#issuecomment-1',
    at: 1700000000000,
    threadKey: 'github:a/b:1',
  }

  it('parses a valid trigger', () => {
    expect(TriggerSchema.parse(trigger)).toMatchObject({ id: 'trg_01', source: 'github' })
  })

  it('rejects unknown fields on a trigger', () => {
    expect(() => TriggerSchema.parse({ ...trigger, extra: 1 })).toThrow()
  })

  it('rejects a trigger whose source is not github', () => {
    expect(() => TriggerSchema.parse({ ...trigger, source: 'slack' })).toThrow()
  })

  it('parses a mandate with strength and policy version', () => {
    const mandate = MandateSchema.parse({
      id: 'man_01',
      policyVersion: 'p1',
      scope: 'fix the flaky test',
      strength: 'explicit',
      rules: ['allowed-actor'],
      actor: { id: 'zephyrbd', bot: false },
      via: 'github',
      createdAt: 1700000000000,
    })
    expect(mandate.strength).toBe('explicit')
    expect(() => MandateSchema.parse({ ...mandate, strength: 'strong' })).toThrow()
  })

  it('parses a ticket with reports and ends', () => {
    const ticket = TicketSchema.parse({
      id: 'tkt_01',
      mandateId: 'man_01',
      status: 'open',
      subscriptions: ['github:a/b:1'],
      reports: [{ kind: 'progress', text: 'working', at: 1 }],
    })
    expect(ticket.status).toBe('open')
    const ended = TicketSchema.parse({ ...ticket, status: 'ended', outcome: 'completed' })
    expect(ended.outcome).toBe('completed')
    expect(() => TicketSchema.parse({ ...ticket, reports: [{ kind: 'done', text: 'x', at: 1 }] })).toThrow()
  })

  it('rejects an unknown report kind', () => {
    expect(() => ReportSchema.parse({ kind: 'finished', text: 'x', at: 1 })).toThrow()
  })

  it('mints unique prefixed ids', () => {
    const a = newTriggerId()
    const b = newTriggerId()
    expect(a).toMatch(/^trg_/)
    expect(b).toMatch(/^trg_/)
    expect(a).not.toBe(b)
    expect(newTicketId()).toMatch(/^tkt_/)
  })
})
