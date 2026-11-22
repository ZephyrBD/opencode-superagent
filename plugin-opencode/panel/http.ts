import { createServer, type Server } from 'node:http'
import type { KV } from '../core/kv.ts'
import type { Ticket } from '../core/model.ts'

const ATTENTION = new Set(['blocked', 'failed'])

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** A healthy state takes no space: the page lists first what needs a person, then one line per ticket. */
export const startPanel = async (deps: { kv: KV }, opts: { port?: number } = {}): Promise<{ url: string; close(): Promise<void> }> => {
  const server: Server = createServer(async (_request, response) => {
    const rows = await deps.kv.scan('ticket/')
    const tickets = rows.map(row => row.value as Ticket)
    const attention = tickets.filter(t => t.reports.at(-1) && ATTENTION.has(t.reports.at(-1)!.kind))
    const others = tickets.filter(t => !attention.includes(t))
    const url = _request.url ?? '/'
    if (url === '/api/state') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        attention: attention.map(t => ({ id: t.id, waiting: t.reports.at(-1)!.text })),
        tickets: others.map(t => ({ id: t.id, status: t.status, last: t.reports.at(-1)?.kind })),
      }))
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<html><body>
<h1>dsh-superagent</h1>
<h2>待人工 Attention</h2>
${attention.map(t => `<p><b>${escapeHtml(t.id)}</b> — ${escapeHtml(t.reports.at(-1)!.text)}</p>`).join('\n') || '<p>无</p>'}
<h2>工单 Tickets</h2>
${others.map(t => `<p>${escapeHtml(t.id)} — ${t.status} — ${t.reports.at(-1)?.kind ?? 'no reports'}</p>`).join('\n') || '<p>无</p>'}
</body></html>`)
  })
  await new Promise<void>(resolve => server.listen(opts.port ?? 4096, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : opts.port ?? 4096
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close(() => resolve()).once('error', reject)),
  }
}
