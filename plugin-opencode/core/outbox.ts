import { randomUUID } from 'node:crypto'
import type { KV } from './kv.ts'

export interface OutboxDeps {
  kv: KV
  clock: () => number
  delay: (ms: number) => Promise<void>
  send(kind: string, payload: unknown): Promise<void>
}

interface Record {
  kind: string
  payload: unknown
  attempts: number
}

const START_MS = 2000
const MAX_MS = 60_000

/**
 * Stored work: every send is persisted before it is attempted, so a crash or reload
 * never loses a message. Records replay on recover.
 */
export class Outbox {
  private readonly kv: KV
  private readonly clock: () => number
  private readonly delay: (ms: number) => Promise<void>
  private readonly send: OutboxDeps['send']
  private failed = new Set<string>()

  constructor(deps: OutboxDeps) {
    this.kv = deps.kv
    this.clock = deps.clock
    this.delay = deps.delay
    this.send = deps.send
  }

  async enqueue(kind: string, payload: unknown): Promise<void> {
    // Clock prefix keeps arrival order; the random suffix keeps concurrent enqueues from colliding.
    const key = `outbox/${String(this.clock()).padStart(13, '0')}_${randomUUID()}`
    await this.kv.set(key, { kind, payload, attempts: 0 } satisfies Record)
    await this.deliver(key)
  }

  private async deliver(key: string): Promise<void> {
    let delayMs = START_MS
    // One deliver pass tries at most three times; a record that still fails stays for recover to replay.
    for (let pass = 0; pass < 3; pass += 1) {
      const record = await this.kv.get<Record>(key)
      if (!record) return
      try {
        await this.send(record.kind, record.payload)
        await this.kv.remove(key)
        this.failed.delete(key)
        return
      } catch {
        record.attempts += 1
        await this.kv.set(key, record)
        if (record.attempts >= 3) this.failed.add(key)
        await this.delay(delayMs)
        delayMs = Math.min(delayMs * 2, MAX_MS)
      }
    }
  }

  problems(): { key: string }[] {
    return [...this.failed].map(key => ({ key }))
  }

  async recover(): Promise<void> {
    const rows = (await this.kv.scan('outbox/')).sort((a, b) => a.key.localeCompare(b.key))
    for (const row of rows) await this.deliver(row.key)
  }
}
