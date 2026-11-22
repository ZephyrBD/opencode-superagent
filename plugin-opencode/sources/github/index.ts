import type { KV } from '../../core/kv.ts'
import type { Trigger } from '../../core/model.ts'

export interface GithubFetchResponse {
  status: number
  json: Promise<unknown> | (() => Promise<unknown>)
}

export interface ThreadInfo {
  number: number
  comments: Array<{ id: number; body: string; html_url: string; created_at: string; user: { login: string; type: string } }>
  state: string
}

export interface GitHubSourceDeps {
  config: { repository: string; allowedActors: string[]; pollSeconds: number; agentLogin: string }
  token: string
  kv: KV
  fetchJSON(url: string, init?: RequestInit): Promise<{ status: number; json(): Promise<unknown> }>
  fetchThread(apiUrl: string): Promise<ThreadInfo>
  intake(trigger: Trigger): Promise<string>
}

interface ApiListResponse {
  full_name?: string
}

/**
 * The GitHub Source: polls the notifications API, translates each unread thread's
 * latest human comment into a Trigger, and remembers its read position.
 */
export class GitHubSource {
  private readonly config: GitHubSourceDeps['config']
  private readonly token: string
  private readonly kv: KV
  private readonly fetchJSON: GitHubSourceDeps['fetchJSON']
  private readonly fetchThread: GitHubSourceDeps['fetchThread']
  private readonly intake: GitHubSourceDeps['intake']
  private failedPolls = 0
  private lastError?: { message: string }

  constructor(deps: GitHubSourceDeps) {
    this.config = deps.config
    this.token = deps.token
    this.kv = deps.kv
    this.fetchJSON = deps.fetchJSON
    this.fetchThread = deps.fetchThread
    this.intake = deps.intake
  }

  /** Thread-level read errors; a failed thread is retried on the next poll, never dropped. */
  async threadErrors(): Promise<{ key: string }[]> {
    const rows = await this.kv.scan('thread-error/')
    return rows.map(row => ({ key: row.key }))
  }

  /** The source's own health; an error is reported only after three failed polls in a row. */
  error(): { message: string } | undefined {
    return this.failedPolls >= 3 ? this.lastError : undefined
  }

  async pollOnce(): Promise<'ok' | 'unchanged'> {
    try {
      const since = await this.kv.get<string>('since')
      const response = await this.fetchJSON(`https://api.github.com/repos/${this.config.repository}/notifications`, {
        headers: this.headers(since ? { 'If-Modified-Since': since } : {}),
      })
      if (response.status === 304) {
        for (const row of await this.kv.scan('thread-error/')) {
          const subjectUrl = (row.value as { subjectUrl: string }).subjectUrl
          if (subjectUrl) await this.readThread({ id: Number(row.key.slice('thread-error/'.length)), subject: { url: subjectUrl } })
        }
        this.failedPolls = 0
        return 'unchanged'
      }
      if (response.status >= 400) {
        const body = await response.json() as { message?: string }
        throw new Error(body.message ?? `HTTP ${response.status}`)
      }
      const modified = (response as unknown as { headers?: Headers }).headers?.get('last-modified')
      const items = await response.json() as Array<{ id: number; subject: { url: string } }>
      const failedNow = new Set<number>()
      for (const item of items) {
        const ok = await this.readThread(item)
        if (!ok) failedNow.add(item.id)
      }
      // A thread that failed on an earlier poll is retried here; one that just failed waits for the
      // next poll, so its error is not wiped by an immediate identical retry.
      for (const row of await this.kv.scan('thread-error/')) {
        const id = Number(row.key.slice('thread-error/'.length))
        if (failedNow.has(id)) continue
        const subjectUrl = (row.value as { subjectUrl: string }).subjectUrl
        if (subjectUrl) await this.readThread({ id, subject: { url: subjectUrl } })
      }
      if (modified) await this.kv.set('since', modified)
      this.failedPolls = 0
      return 'ok'
    } catch (error) {
      this.failedPolls += 1
      this.lastError = { message: error instanceof Error ? error.message : String(error) }
      return 'ok'
    }
  }

  /** Reads one thread; returns whether it succeeded, so the poll can tell fresh failures from old ones. */
  private async readThread(item: { id: number; subject: { url: string } }): Promise<boolean> {
    const seenKey = `seen/${item.id}`
    if (await this.kv.get(seenKey)) return true
    let thread: ThreadInfo
    try {
      thread = await this.fetchThread(item.subject.url)
      if ((thread as unknown as { status?: number }).status === 404) throw new Error('HTTP 404')
    } catch (error) {
      // A failed read keeps its error on the thread and is retried next poll; the read position stays.
      await this.kv.set(`thread-error/${item.id}`, { message: error instanceof Error ? error.message : String(error), subjectUrl: item.subject.url })
      return false
    }
    await this.kv.remove(`thread-error/${item.id}`)
    const humans = thread.comments.filter(c => c.user.login !== this.config.agentLogin && c.user.type !== 'Bot')
    const latest = humans.at(-1)
    if (!latest) {
      await this.kv.set(seenKey, true)
      return true
    }
    const apiRepo = await this.repoName(item.subject.url)
    const trigger: Trigger = {
      id: `trg_github_${latest.id}`,
      source: 'github',
      actor: { id: latest.user.login, bot: false },
      text: latest.body,
      url: latest.html_url,
      at: Date.parse(latest.created_at),
      threadKey: `github:${apiRepo}:${thread.number}`,
    }
    await this.intake(trigger)
    await this.kv.set(seenKey, true)
    return true
  }

  private async repoName(subjectUrl: string): Promise<string> {
    const apiRepo = await this.kv.get<string>('api-repo-name')
    if (apiRepo) return apiRepo
    const response = await this.fetchJSON(`https://api.github.com/repos/${this.config.repository}`, { headers: this.headers({}) })
    const body = await response.json() as ApiListResponse
    const name = body.full_name ?? this.config.repository
    await this.kv.set('api-repo-name', name)
    return name
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      ...extra,
    }
  }
}

/** The write side of a GitHub thread: replies land as issue comments. */
export class GitHubChannel {
  private readonly config: GitHubSourceDeps['config']
  private readonly token: string
  private readonly fetchJSON: GitHubSourceDeps['fetchJSON']

  constructor(deps: Pick<GitHubSourceDeps, 'config' | 'token' | 'fetchJSON'>) {
    this.config = deps.config
    this.token = deps.token
    this.fetchJSON = deps.fetchJSON
  }

  async reply(threadKey: string, text: string): Promise<void> {
    const number = threadKey.split(':').at(-1)!
    await this.fetchJSON(`https://api.github.com/repos/${this.config.repository}/issues/${number}/comments`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ body: text }),
    })
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra }
  }
}
