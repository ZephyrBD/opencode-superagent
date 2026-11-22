import { z } from 'zod'

export const ActorSchema = z.object({ id: z.string().min(1), bot: z.boolean() }).strict()
export type Actor = z.infer<typeof ActorSchema>

export const TriggerSchema = z.object({
  id: z.string().min(1),
  source: z.enum(['github', 'feishu']),
  actor: ActorSchema,
  text: z.string(),
  url: z.string(),
  at: z.number().int(),
  threadKey: z.string().min(1),
}).strict()
export type Trigger = z.infer<typeof TriggerSchema>

export const ReportSchema = z.object({
  kind: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
  text: z.string(),
  at: z.number().int(),
}).strict()
export type Report = z.infer<typeof ReportSchema>

export const MandateSchema = z.object({
  id: z.string().min(1),
  policyVersion: z.string().min(1),
  scope: z.string().min(1),
  strength: z.enum(['explicit', 'inferred']),
  rules: z.array(z.string()),
  actor: ActorSchema,
  via: z.string().min(1),
  createdAt: z.number().int(),
}).strict()
export type Mandate = z.infer<typeof MandateSchema>

export const TicketSchema = z.object({
  id: z.string().min(1),
  mandateId: z.string().min(1),
  status: z.enum(['open', 'ended']),
  outcome: z.enum(['completed', 'dropped', 'stopped']).optional(),
  sessionId: z.string().optional(),
  directory: z.string().optional(),
  subscriptions: z.array(z.string()),
  reports: z.array(ReportSchema),
  assignmentIds: z.array(z.string()).optional(),
  /** Delivering an input to the worker failed and is being retried. */
  deliveryFailed: z.boolean().optional(),
  /** A structured question that waits for a person's answer. */
  attention: z.object({ question: z.string(), at: z.number().int() }).optional(),
}).strict()
export type Ticket = z.infer<typeof TicketSchema>

export const DecisionSchema = z.object({
  kind: z.enum(['accept', 'stop', 'ignore', 'unavailable']),
  reason: z.string().optional(),
  scope: z.string().optional(),
  ticketId: z.string().optional(),
}).strict()
export type Decision = z.infer<typeof DecisionSchema>

/** What intake did with one trigger. `recorded` means a proactive rule matched but only the record is kept. */
export type Disposition = 'filtered' | 'evaluated' | 'fannedOut' | 'recorded'
