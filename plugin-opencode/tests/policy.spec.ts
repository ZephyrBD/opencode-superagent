import { describe, expect, it } from 'vitest'
import { gate, revalidate, type Policy } from '../core/policy.ts'
import type { Ticket, Trigger } from '../core/model.ts'

export const policy = (over: Partial<Policy> = {}): Policy => ({
  policyVersion: 'p1',
  paused: false,
  proactive: 'record',
  github: { repository: 'a/b', allowedActors: ['zephyrbd'], pollSeconds: 60, agentLogin: 'agent-bot' },
  ...over,
})

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

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tkt_1',
  mandateId: 'man_1',
  status: 'open',
  subscriptions: [],
  reports: [],
  assignmentIds: [],
  ...over,
})

describe('gate', () => {
  it('admits an allowed actor as explicit', () => {
    expect(gate(policy(), trigger(), [])).toEqual({ admissible: true, strength: 'explicit' })
  })

  it('rejects an actor not on the allowed list', () => {
    const result = gate(policy(), trigger({ actor: { id: 'stranger', bot: false } }), [])
    expect(result).toEqual({ admissible: false, reason: 'actor-not-allowed' })
  })

  it('rejects bots outright', () => {
    expect(gate(policy(), trigger({ actor: { id: 'some-bot', bot: true } }), []))
      .toEqual({ admissible: false, reason: 'bot-ignored' })
  })

  it('rejects the agent own account', () => {
    expect(gate(policy(), trigger({ actor: { id: 'agent-bot', bot: true } }), []))
      .toEqual({ admissible: false, reason: 'bot-ignored' })
  })

  it('rejects everything while paused', () => {
    expect(gate(policy({ paused: true }), trigger(), [])).toEqual({ admissible: false, reason: 'paused' })
  })

  it('marks a repository-owner human request as inferred under record mode', () => {
    const result = gate(policy({ proactive: 'record', github: { repository: 'zephyrbd/b', allowedActors: [], pollSeconds: 60, agentLogin: 'agent-bot' } }),
      trigger({ actor: { id: 'zephyrbd', bot: false } }), [])
    expect(result).toEqual({ admissible: true, strength: 'inferred', recordOnly: true })
  })

  it('admits inferred only when proactive is act', () => {
    const result = gate(policy({ proactive: 'act', github: { repository: 'zephyrbd/b', allowedActors: [], pollSeconds: 60, agentLogin: 'agent-bot' } }),
      trigger({ actor: { id: 'zephyrbd', bot: false } }), [])
    expect(result).toEqual({ admissible: true, strength: 'inferred' })
  })

  it('does not offer inferred when the actor is not the repository owner', () => {
    expect(gate(policy({ proactive: 'act', github: { repository: 'a/b', allowedActors: [], pollSeconds: 60, agentLogin: 'agent-bot' } }),
      trigger({ actor: { id: 'someone', bot: false } }), [])).toEqual({ admissible: false, reason: 'actor-not-allowed' })
  })
})

describe('revalidate', () => {
  const mandate = { policyVersion: 'p1' } as never
  it('holds under the same policy version', () => {
    expect(revalidate(policy(), mandate)).toBe(true)
  })
  it('falls when the policy version moved on', () => {
    expect(revalidate(policy({ policyVersion: 'p2' }), mandate)).toBe(false)
  })
  it('falls while paused', () => {
    expect(revalidate(policy({ paused: true }), mandate)).toBe(false)
  })
})
