import { describe, expect, it, vi } from 'vitest'
import { Outbox } from '../core/outbox.ts'
import { MemoryKV } from '../core/kv.ts'

describe('outbox', () => {
  it('sends and clears the record on success', async () => {
    const kv = MemoryKV()
    const outbox = new Outbox({ kv, clock: () => 0, delay: async () => {}, send: async () => {} })
    await outbox.enqueue('reply', { text: 'hi' })
    expect(await kv.scan('outbox/')).toHaveLength(0)
  })

  it('keeps the record and retries with backoff until it succeeds', async () => {
    const kv = MemoryKV()
    const delays: number[] = []
    let attempts = 0
    const outbox = new Outbox({
      kv,
      clock: () => 0,
      delay: async ms => { delays.push(ms) },
      send: async () => {
        attempts += 1
        if (attempts < 3) throw new Error('flaky')
      },
    })
    await outbox.enqueue('reply', {})
    expect(attempts).toBe(3)
    expect(delays).toEqual([2000, 4000])
    expect(await kv.scan('outbox/')).toHaveLength(0)
  })

  it('flags a problem after three consecutive failures and keeps the record', async () => {
    const kv = MemoryKV()
    const outbox = new Outbox({
      kv,
      clock: () => 0,
      delay: async () => {},
      send: async () => { throw new Error('down') },
    })
    await outbox.enqueue('reply', { a: 1 })
    expect(await kv.scan('outbox/')).toHaveLength(1)
    expect(outbox.problems()).toHaveLength(1)
  })

  it('keeps every record when enqueues race', async () => {
    const kv = MemoryKV()
    const sent: unknown[] = []
    const outbox = new Outbox({ kv, clock: () => 0, delay: async () => {}, send: async (_kind, payload) => { sent.push(payload) } })
    await Promise.all([
      outbox.enqueue('reply', { n: 1 }),
      outbox.enqueue('reply', { n: 2 }),
      outbox.enqueue('reply', { n: 3 }),
    ])
    expect(sent).toHaveLength(3)
    expect(new Set(sent.map(p => (p as { n: number }).n)).size).toBe(3)
  })

  it('rebuilds problem flags from durable records on recover', async () => {
    const kv = MemoryKV()
    await kv.set('outbox/000001', { kind: 'reply', payload: { a: 1 }, attempts: 3 })
    const outbox = new Outbox({
      kv, clock: () => 0,
      delay: async () => {},
      send: async () => { throw new Error('still down') },
    })
    await outbox.recover()
    expect(outbox.problems()).toHaveLength(1)
  })

  it('replays records left over from a crash on recover', async () => {
    const kv = MemoryKV()
    await kv.set('outbox/000001', { kind: 'reply', payload: { n: 1 } })
    const sent: unknown[] = []
    const outbox = new Outbox({ kv, clock: () => 0, delay: async () => {}, send: async (kind, payload) => { sent.push([kind, payload]) } })
    await outbox.recover()
    expect(sent).toEqual([['reply', { n: 1 }]])
    expect(await kv.scan('outbox/')).toHaveLength(0)
  })
})
