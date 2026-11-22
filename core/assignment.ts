import { z } from 'zod'

/**
 * The binding of a Ticket to one Executor launch. It moves independently of the
 * Ticket's own state: a Ticket survives several assignments over time.
 */
export const AssignmentSchema = z.object({
  id: z.string().min(1),
  ticketId: z.string().min(1),
  status: z.enum(['pending', 'running', 'ended']),
  endReason: z.string().optional(),
  startedAt: z.number().int(),
  endedAt: z.number().int().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'ended' && !value.endReason) {
    ctx.addIssue({ code: 'custom', message: 'an ended assignment must carry an end reason' })
  }
})
export type Assignment = z.infer<typeof AssignmentSchema>
