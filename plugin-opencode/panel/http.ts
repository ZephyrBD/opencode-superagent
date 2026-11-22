import { createServer, type Server } from 'node:http'
import type { KV } from '../core/kv.ts'
import type { Assignment } from '../core/assignment.ts'
import type { Ticket } from '../core/model.ts'
import { isPersonStage, stageOf } from '../core/stage.ts'

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const waitingText = (ticket: Ticket): string => {
  if (ticket.attention) return ticket.attention.question
  if (ticket.deliveryFailed) return 'input delivery is being retried'
  const last = ticket.reports.at(-1)
  return last?.text ?? 'starting'
}

/** A healthy state takes no space: the page lists first what needs a person, then one line per ticket. */
export const startPanel = async (deps: { kv: KV }, opts: { port?: number } = {}): Promise<{ url: string; close(): Promise<void> }> => {
  const server: Server = createServer(async (_request, response) => {
    const tickets = (await deps.kv.scan('ticket/')).map(row => row.value as Ticket)
    const assignments = (await deps.kv.scan('assignment/')).map(row => row.value as Assignment)
    const assignmentsOf = (ticket: Ticket): Assignment[] =>
      assignments.filter(assignment => ticket.assignmentIds?.includes(assignment.id))
    const withStage = tickets.map(ticket => ({ ticket, stage: stageOf(ticket, assignmentsOf(ticket), false) }))
    const attention = withStage.filter(({ stage }) => isPersonStage(stage))
    const others = withStage.filter(({ stage }) => !isPersonStage(stage))
    const url = _request.url ?? '/'
    if (url === '/api/state') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        attention: attention.map(({ ticket, stage }) => ({ id: ticket.id, stage, waiting: waitingText(ticket) })),
        tickets: others.map(({ ticket, stage }) => ({ id: ticket.id, stage, last: ticket.reports.at(-1)?.kind })),
      }))
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<html><body>
<h1>dsh-superagent</h1>
<h2>待人工 Attention</h2>
${attention.map(({ ticket, stage }) => `<p><b>${escapeHtml(ticket.id)}</b> [${stage}] — ${escapeHtml(waitingText(ticket))}</p>`).join('\n') || '<p>无</p>'}
<h2>工单 Tickets</h2>
${others.map(({ ticket, stage }) => `<p>${escapeHtml(ticket.id)} — ${stage} — ${ticket.reports.at(-1)?.kind ?? 'no reports'}</p>`).join('\n') || '<p>无</p>'}
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
