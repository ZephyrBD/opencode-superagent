import { describe, expect, it } from 'vitest'
import { FallbackAssessor, SessionOrchestrator } from '../core/orchestrator.ts'
import { LlmAssessor } from '../core/assessor.ts'
import type { SessionPort } from '../core/executor.ts'
import type { ThreadState } from '../core/engine.ts'
import type { Trigger } from '../core/model.ts'

const trigger = (): Trigger => ({
  id: 'trg_1',
  source: 'github',
  actor: { id: 'zephyrbd', bot: false },
  text: 'fix the flaky test',
  url: 'u',
  at: 1,
  threadKey: 'github:a/b:1',
})

const thread = (): ThreadState => ({ key: 'github:a/b:1', triggers: [trigger()], ticketIds: [], decisions: [] })

const scriptedSessions = (replies: string[]) => {
  const created: string[] = []
  const prompts: string[] = []
  let n = 0
  const sessions: SessionPort = {
    create: async title => {
      created.push(title)
      n += 1
      return { sessionID: `orch_${n}` }
    },
    prompt: async (_sessionID, text) => {
      prompts.push(text)
      const reply = replies.shift() ?? '{"kind":"unavailable"}'
      // The orchestrator answers through its report tool in reality; the fake hands it back directly.
      ;(sessions as unknown as { lastReply: string }).lastReply = reply
    },
    interrupt: async () => {},
  }
  return { sessions, created, prompts }
}

describe('session orchestrator', () => {
  it('drives one long-lived session and parses its decision', async () => {
    const { sessions, created } = scriptedSessions(['{"kind":"accept","scope":"fix the flaky test"}'])
    const orchestrator = new SessionOrchestrator({ sessions, replyOf: () => '{"kind":"accept","scope":"fix the flaky test"}' })
    const decision = await orchestrator.assess({ batch: [trigger()], thread: thread(), tickets: [] })
    expect(decision).toMatchObject({ kind: 'accept', scope: 'fix the flaky test' })
    expect(created).toHaveLength(1)
    const second = await orchestrator.assess({ batch: [trigger()], thread: thread(), tickets: [] })
    expect(second.kind).toBe('accept')
    expect(created).toHaveLength(1)
  })

  it('falls back to the plain assessor when the session gives no verdict', async () => {
    const { sessions } = scriptedSessions([])
    const fallback = new LlmAssessor({ generate: { text: async () => ({ text: '{"kind":"ignore","reason":"chatter"}' }) } })
    const orchestrator = new SessionOrchestrator({
      sessions,
      replyOf: () => 'I cannot decide.',
      fallback,
    })
    const decision = await orchestrator.assess({ batch: [trigger()], thread: thread(), tickets: [] })
    expect(decision).toMatchObject({ kind: 'ignore', reason: 'chatter' })
  })

  it('returns unavailable when both layers fail', async () => {
    const { sessions } = scriptedSessions([])
    const fallback = new LlmAssessor({ generate: { text: async () => ({ text: 'nope' }) } })
    const orchestrator = new SessionOrchestrator({ sessions, replyOf: () => 'nope', fallback })
    const decision = await orchestrator.assess({ batch: [trigger()], thread: thread(), tickets: [] })
    expect(decision.kind).toBe('unavailable')
  })
})

describe('fallback assessor wiring', () => {
  it('prefers the orchestrator and uses the plain assessor only on unavailable', async () => {
    const primaryCalls: number[] = []
    const secondaryCalls: number[] = []
    const primary = {
      assess: async () => {
        primaryCalls.push(1)
        return { kind: 'accept' as const, scope: 'primary' }
      },
    }
    const secondary = {
      assess: async () => {
        secondaryCalls.push(1)
        return { kind: 'accept' as const, scope: 'secondary' }
      },
    }
    const composite = new FallbackAssessor(primary, secondary)
    const decision = await composite.assess({ batch: [trigger()], thread: thread(), tickets: [] })
    expect(decision.scope).toBe('primary')
    expect(secondaryCalls).toHaveLength(0)
  })
})
