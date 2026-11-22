import { z } from 'zod'
import type { Mandate, Ticket, Trigger } from './model.ts'

export const GithubSourceConfigSchema = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  allowedActors: z.array(z.string()).default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(60),
  agentLogin: z.string().min(1),
}).strict()
export type GithubSourceConfig = z.infer<typeof GithubSourceConfigSchema>

export const PolicySchema = z.object({
  policyVersion: z.string().min(1),
  paused: z.boolean().default(false),
  /** Proactive work (nobody asked) starts in record mode: it is judged and noted, never executed. */
  proactive: z.enum(['off', 'record', 'act']).default('record'),
  github: GithubSourceConfigSchema,
  feishu: z.object({
    chats: z.array(z.object({ id: z.string().min(1), listen: z.enum(['mentions', 'all']) }).strict()).default([]),
    pollSeconds: z.number().int().min(10).max(3600).default(30),
    cliPath: z.string().default('lark-cli'),
  }).strict().optional(),
}).strict()
export type Policy = z.infer<typeof PolicySchema>

export type GateResult =
  | { admissible: false; reason: string }
  | { admissible: true; strength: 'explicit' | 'inferred'; recordOnly?: true }

/** Deterministic first layer of Eval: who may originate work. Assessment comes later, on the model. */
export const gate = (policy: Policy, trigger: Trigger, _tickets: readonly Ticket[]): GateResult => {
  if (policy.paused) return { admissible: false, reason: 'paused' }
  if (trigger.actor.bot) return { admissible: false, reason: 'bot-ignored' }
  if (policy.github.allowedActors.includes(trigger.actor.id)) return { admissible: true, strength: 'explicit' }
  const [owner] = policy.github.repository.split('/') as [string | undefined, ...string[]]
  if (policy.proactive !== 'off' && owner === trigger.actor.id) {
    return policy.proactive === 'act' ? { admissible: true, strength: 'inferred' } : { admissible: true, strength: 'inferred', recordOnly: true }
  }
  return { admissible: false, reason: 'actor-not-allowed' }
}

/** Whether a mandate's gate-layer basis still holds, e.g. before an ended ticket resumes. */
export const revalidate = (policy: Policy, mandate: Pick<Mandate, 'policyVersion'>): boolean =>
  !policy.paused && mandate.policyVersion === policy.policyVersion
