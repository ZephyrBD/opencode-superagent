import { describe, expect, it } from 'vitest'
import { startPanel } from '../panel/http.ts'
import { MemoryKV } from '../core/kv.ts'

const ticket = (over: Record<string, unknown> = {}) => ({
  id: 'tkt_1',
  mandateId: 'man_1',
  status: 'open',
  subscriptions: [],
  reports: [],
  ...over,
})

const kvWith = async (tickets: Record<string, unknown>[]) => {
  const kv = MemoryKV()
  for (const [index, t] of tickets.entries()) await kv.set(`ticket/tkt_${index}`, t)
  return kv
}

describe('panel', () => {
  it('lists only blocked and failed tickets as needing a person', async () => {
    const kv = await kvWith([
      ticket({ reports: [{ kind: 'blocked', text: 'need a decision', at: 1 }] }),
      ticket({ id: 'tkt_other', reports: [{ kind: 'progress', text: 'working', at: 1 }] }),
    ])
    const panel = await startPanel({ kv }, { port: 0 })
    const response = await fetch(`${panel.url}/api/state`)
    const state = await response.json() as { attention: { id: string }[] }
    expect(state.attention.map(t => t.id)).toEqual(['tkt_1'])
    await panel.close()
  })

  it('renders the page with waiting ticket names', async () => {
    const kv = await kvWith([
      ticket({ reports: [{ kind: 'blocked', text: 'need a decision', at: 1 }] }),
      ticket({ id: 'tkt_2', reports: [{ kind: 'progress', text: 'working on it', at: 2 }] }),
    ])
    const panel = await startPanel({ kv }, { port: 0 })
    const response = await fetch(panel.url)
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('tkt_1')
    expect(html).toContain('tkt_2')
    expect(html).toContain('need a decision')
    await panel.close()
  })

  it('escapes report text so a hostile comment cannot inject script', async () => {
    const kv = await kvWith([
      ticket({ reports: [{ kind: 'blocked', text: '<script>alert(1)</script>', at: 1 }] }),
    ])
    const panel = await startPanel({ kv }, { port: 0 })
    const html = await fetch(panel.url).then(r => r.text())
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    await panel.close()
  })

  it('releases the port on close', async () => {
    const panel = await startPanel({ kv: MemoryKV() }, { port: 0 })
    const url = panel.url
    await panel.close()
    await expect(fetch(url)).rejects.toThrow()
  })
})
