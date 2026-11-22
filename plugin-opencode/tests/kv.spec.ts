import { describe, expect, it } from 'vitest'
import { MemoryKV, PrefixKV } from '../core/kv.ts'

describe('KV', () => {
  it('stores and reads a value by key', async () => {
    const kv = MemoryKV()
    await kv.set('a/1', { x: 1 })
    expect(await kv.get('a/1')).toEqual({ x: 1 })
    expect(await kv.get('a/missing')).toBeUndefined()
  })

  it('overwrites and removes', async () => {
    const kv = MemoryKV()
    await kv.set('a/1', 1)
    await kv.set('a/1', 2)
    expect(await kv.get('a/1')).toBe(2)
    await kv.remove('a/1')
    expect(await kv.get('a/1')).toBeUndefined()
  })

  it('scans by prefix', async () => {
    const kv = MemoryKV()
    await kv.set('thread/1', 'a')
    await kv.set('thread/2', 'b')
    await kv.set('ticket/1', 'c')
    const rows = await kv.scan('thread/')
    expect(rows.map(r => r.key).sort()).toEqual(['thread/1', 'thread/2'])
  })

  it('PrefixKV isolates namespaces', async () => {
    const kv = MemoryKV()
    const threads = PrefixKV(kv, 'thread/')
    const tickets = PrefixKV(kv, 'ticket/')
    await threads.set('1', 'a')
    expect(await tickets.get('1')).toBeUndefined()
    expect(await kv.get('thread/1')).toBe('a')
    await tickets.set('1', 'c')
    expect((await tickets.scan('')).map(r => r.key)).toEqual(['1'])
  })
})
