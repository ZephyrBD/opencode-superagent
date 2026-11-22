import type { Assessor, ThreadState } from './engine.ts'
import type { SessionPort } from './executor.ts'
import type { Decision, Ticket, Trigger } from './model.ts'

export interface OrchestratorDeps {
  sessions: SessionPort
  /** Answers for the scripted session in tests; production wires the real reply capture. */
  replyOf?: (prompt: string) => string
  fallback?: Assessor
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

const KINDS = new Set(['accept', 'stop', 'ignore'])

/**
 * The orchestrator is one long-lived session: it accumulates the thread history
 * across evals, so later batches carry its earlier judgement. A verdict the
 * session cannot give falls through to the plain assessor.
 */
export class SessionOrchestrator implements Assessor {
  private readonly sessions: SessionPort
  private readonly replyOf?: OrchestratorDeps['replyOf']
  private readonly fallback?: Assessor
  private sessionId?: string

  constructor(deps: OrchestratorDeps) {
    this.sessions = deps.sessions
    this.replyOf = deps.replyOf
    this.fallback = deps.fallback
  }

  async assess(input: { batch: Trigger[]; thread: ThreadState; tickets: readonly Ticket[] }): Promise<Decision> {
    if (!this.sessionId) {
      const { sessionID } = await this.sessions.create('orchestrator', 'orchestrator')
      this.sessionId = sessionID
    }
    const prompt = [
      'Latest triggers:',
      ...input.batch.map(t => `- [${t.actor.id}] ${t.text} (${t.url})`),
      `Thread ${input.thread.key}: ${input.thread.triggers.length} trigger(s) seen, tickets ${input.thread.ticketIds.join(', ') || 'none'}, prior decisions ${input.thread.decisions.length}.`,
      'Answer with exactly one JSON object: {"kind":"accept|stop|ignore","scope":"...","reason":"..."}',
    ].join('\n')
    await this.sessions.prompt(this.sessionId, prompt)
    const reply = this.sessions.lastAssistantText
      ? await this.sessions.lastAssistantText(this.sessionId)
      : this.replyOf?.(prompt) ?? '{"kind":"unavailable"}'
    const parsed = extractJson(reply)
    const kind = typeof parsed?.kind === 'string' ? parsed.kind : undefined
    if (!parsed || !kind || !KINDS.has(kind)) {
      if (this.fallback) return this.fallback.assess(input)
      return { kind: 'unavailable', reason: `orchestrator gave no verdict: ${reply.slice(0, 120)}` }
    }
    return {
      kind: kind as Decision['kind'],
      scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    }
  }
}

/** Tries the orchestrator first; the plain assessor only sees evals the session could not judge. */
export class FallbackAssessor implements Assessor {
  private readonly primary: Assessor
  private readonly secondary: Assessor

  constructor(primary: Assessor, secondary: Assessor) {
    this.primary = primary
    this.secondary = secondary
  }

  async assess(input: { batch: Trigger[]; thread: ThreadState; tickets: readonly Ticket[] }): Promise<Decision> {
    const decision = await this.primary.assess(input)
    if (decision.kind !== 'unavailable') return decision
    return this.secondary.assess(input)
  }
}
