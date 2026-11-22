import type { Assessor, ThreadState } from './engine.ts'
import type { Decision, Ticket, Trigger } from './model.ts'

export interface GeneratePort {
  text(opts: { prompt: string }): Promise<{ text: string }>
}

export interface AssessorDeps {
  generate: GeneratePort
  timeoutMs?: number
}

const extractJson = (text: string): Record<string, unknown> | undefined => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

const KINDS = new Set(['accept', 'stop', 'ignore', 'unavailable'])

/** The model's judgement layer of Eval. Never guesses: a missing or malformed verdict is `unavailable`. */
export class LlmAssessor implements Assessor {
  private readonly generate: GeneratePort
  private readonly timeoutMs: number

  constructor(deps: AssessorDeps) {
    this.generate = deps.generate
    this.timeoutMs = deps.timeoutMs ?? 60_000
  }

  async assess(input: { batch: Trigger[]; thread: ThreadState; tickets: readonly Ticket[] }): Promise<Decision> {
    const prompt = [
      'Latest triggers:',
      ...input.batch.map(t => `- [${t.actor.id}] ${t.text} (${t.url})`),
      '',
      `Thread ${input.thread.key} history: ${input.thread.triggers.length} trigger(s), tickets: ${input.thread.ticketIds.join(', ') || 'none'}.`,
      `Live tickets: ${input.tickets.filter(t => t.status === 'open').length}.`,
      '',
      'Decide.',
    ].join('\n')
    let text: string
    try {
      const result = await Promise.race([
        this.generate.text({ prompt }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('assessor timeout')), this.timeoutMs)),
      ])
      text = result.text
    } catch (error) {
      return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
    const parsed = extractJson(text)
    const kind = typeof parsed?.kind === 'string' ? parsed.kind : undefined
    if (!parsed || !kind || !KINDS.has(kind) || kind === 'unavailable') {
      return { kind: 'unavailable', reason: `assessor gave no verdict: ${text.slice(0, 120)}` }
    }
    return {
      kind: kind as Decision['kind'],
      scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    }
  }
}
