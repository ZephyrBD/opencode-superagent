import { describe, expect, it } from 'vitest'
import { LlmAssessor } from '../core/assessor.ts'
import type { ThreadState } from '../core/engine.ts'
import type { Trigger } from '../core/model.ts'

const trigger = (over: Partial<Trigger> = {}): Trigger => ({
  id: 'trg_1',
  source: 'github',
  actor: { id: 'zephyrbd', bot: false },
  text: 'fix the flaky test',
  url: 'u',
  at: 1,
  threadKey: 'github:a/b:1',
  ...over,
})

const thread = (): ThreadState => ({ key: 'github:a/b:1', triggers: [trigger()], ticketIds: [], decisions: [] })

describe('llm assessor', () => {
  it('parses a plain JSON accept into a decision', async () => {
    const assessor = new LlmAssessor({ generate: { text: async () => ({ text: '{"kind":"accept","scope":"fix the flaky test"}' }) } })
    const decision = await assessor.assess({ batch: [trigger()], thread: thread(), tickets: [] })
    expect(decision).toMatchObject({ kind: 'accept', scope: 'fix the flaky test' })
  })

  it('parses JSON wrapped in a markdown fence', async () => {
    const assessor = new LlmAssessor({
      generate: { text: async () => ({ text: 'Here is my decision:\n```json\n{"kind":"ignore","reason":"not work"}\n```' }) },
    })
    const decision = await assessor.assess({ batch: [trigger()], thread: thread(), tickets: [] })
    expect(decision.kind).toBe('ignore')
  })

  it('returns unavailable on timeout', async () => {
    const assessor = new LlmAssessor({
      generate: { text: () => new Promise(resolve => setTimeout(resolve, 200)) },
      timeoutMs: 10,
    })
    const decision = await assessor.assess({ batch: [trigger()], thread: thread(), tickets: [] })
    expect(decision.kind).toBe('unavailable')
  })

  it('returns unavailable when the output is not JSON', async () => {
    const assessor = new LlmAssessor({ generate: { text: async () => ({ text: 'I cannot decide.' }) } })
    const decision = await assessor.assess({ batch: [trigger()], thread: thread(), tickets: [] })
    expect(decision.kind).toBe('unavailable')
  })

  it('returns unavailable when the kind is not one of the four', async () => {
    const assessor = new LlmAssessor({ generate: { text: async () => ({ text: '{"kind":"maybe"}' }) } })
    const decision = await assessor.assess({ batch: [trigger()], thread: thread(), tickets: [] })
    expect(decision.kind).toBe('unavailable')
  })
})
