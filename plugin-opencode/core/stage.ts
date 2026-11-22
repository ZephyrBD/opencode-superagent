import type { Assignment } from './assignment.ts'
import type { Report, Ticket } from './model.ts'

export type Stage =
  | 'person/delivery'
  | 'person/answer'
  | 'person/review'
  | 'person/blocked'
  | 'person/failed'
  | 'working/queued'
  | 'idle'
  | 'working'

/** Read from top to bottom; the first matching row wins (docs/003-execution.md). */
export const stageOf = (ticket: Ticket, assignments: readonly Assignment[], personMessageSinceLastReport: boolean): Stage => {
  if (ticket.deliveryFailed) return 'person/delivery'
  if (ticket.attention) return 'person/answer'
  const last: Report | undefined = ticket.reports.at(-1)
  if (last?.kind === 'ready') return 'person/review'
  if (last?.kind === 'blocked' && !personMessageSinceLastReport) return 'person/blocked'
  if (last?.kind === 'failed' && !personMessageSinceLastReport) return 'person/failed'
  const live = assignments.find(assignment => assignment.status !== 'ended')
  if (last?.kind === 'waiting') return 'idle'
  if (assignments.length > 0 && !live) return 'idle'
  if (!live || live.status === 'pending') return 'working/queued'
  return 'working'
}

export const isPersonStage = (stage: Stage): boolean => stage.startsWith('person/')
