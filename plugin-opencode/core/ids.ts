import { randomUUID } from 'node:crypto'

const mint = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '')}`

export const newTriggerId = (): string => mint('trg')
export const newTicketId = (): string => mint('tkt')
export const newMandateId = (): string => mint('man')
export const newDecisionId = (): string => mint('dec')
