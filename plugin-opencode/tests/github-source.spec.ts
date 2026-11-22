import { describe, expect, it } from 'vitest'
import { GitHubChannel, GitHubSource } from '../sources/github/index.ts'
import { MemoryKV } from '../core/kv.ts'
import type { Trigger } from '../core/model.ts'

const comment = (over: Record<string, unknown> = {}) => ({
  id: 100,
  body: 'please fix the flaky test',
  html_url: 'https://github.com/a/b/issues/1#issuecomment-100',
  created_at: '2026-01-01T00:00:00Z',
  user: { login: 'zephyrbd', type: 'User' },
  ...over,
})

const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
  ({ status: 200, json: async () => body, headers: new Headers(headers) }) as unknown as Response

const fakeFetch = (responses: Array<{ status: number; body: unknown }>) => {
  const calls: { url: string; init?: RequestInit }[] = []
  let n = 0
  const fetchJSON = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const next = responses[n]
    n += 1
    if (!next) return { status: 304, json: async () => ({}) }
    return { status: next.status, json: async () => next.body }
  }
  return { fetchJSON, calls }
}

const config = { repository: 'a/b', allowedActors: ['zephyrbd'], pollSeconds: 60, agentLogin: 'agent-bot' }

describe('github source', () => {
  it('turns an issue comment into a trigger and delivers it to intake', async () => {
    const { fetchJSON } = fakeFetch([
      { status: 200, body: [{ subject: { url: 'https://api.github.com/repos/a/b/issues/1' }, reason: 'comment' }] },
    ])
    const received: Trigger[] = []
    const source = new GitHubSource({
      config,
      token: 'tok',
      kv: MemoryKV(),
      fetchJSON,
      // The poll reads the thread body to find the actor of the latest human comment.
      fetchThread: async () => ({ number: 1, comments: [comment()], state: 'open' }),
      intake: async t => {
        received.push(t)
        return 'evaluated'
      },
    })
    const result = await source.pollOnce()
    expect(result).toBe('ok')
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      source: 'github',
      actor: { id: 'zephyrbd', bot: false },
      text: 'please fix the flaky test',
      threadKey: 'github:a/b:1',
    })
  })

  it('drops the agent own comments and bot comments', async () => {
    const { fetchJSON } = fakeFetch([
      { status: 200, body: [{ id: 1, subject: { url: "https://api.github.com/repos/a/b/issues/1" } }] },
    ])
    const received: Trigger[] = []
    const source = new GitHubSource({
      config,
      token: 'tok',
      kv: MemoryKV(),
      fetchJSON,
      fetchThread: async () => ({
        number: 1,
        comments: [
          comment({ user: { login: 'agent-bot', type: 'Bot' } }),
          comment({ id: 101, user: { login: 'dep-bot', type: 'Bot' }, body: 'CI passed' }),
        ],
        state: 'open',
      }),
      intake: async t => {
        received.push(t)
        return 'evaluated'
      },
    })
    await source.pollOnce()
    expect(received).toHaveLength(0)
  })

  it('does not replay already-seen notifications', async () => {
    const notification = { id: 1, subject: { url: "https://api.github.com/repos/a/b/issues/1" } }
    const { fetchJSON } = fakeFetch([
      { status: 200, body: [notification] },
      { status: 200, body: [notification] },
    ])
    const kv = MemoryKV()
    const received: Trigger[] = []
    const source = new GitHubSource({
      config, token: 'tok', kv, fetchJSON,
      fetchThread: async () => ({ number: 1, comments: [comment()], state: 'open' }),
      intake: async t => {
        received.push(t)
        return 'evaluated'
      },
    })
    await source.pollOnce()
    await source.pollOnce()
    expect(received).toHaveLength(1)
  })

  it('retries a failed thread read on later polls and still delivers the trigger', async () => {
    let attempts = 0
    const fetchThread = async () => {
      attempts += 1
      if (attempts === 1) return { status: 404, number: 0, comments: [], state: 'open' } as never
      return { number: 1, comments: [comment()], state: 'open' }
    }
    const { fetchJSON } = fakeFetch([
      { status: 200, body: [{ id: 1, subject: { url: "https://api.github.com/repos/a/b/issues/1" } }] },
      { status: 304, body: {} },
    ])
    const received: Trigger[] = []
    const source = new GitHubSource({
      config, token: 'tok', kv: MemoryKV(), fetchJSON,
      fetchThread,
      intake: async t => {
        received.push(t)
        return 'evaluated'
      },
    })
    await source.pollOnce()
    expect(received).toHaveLength(0)
    await source.pollOnce()
    expect(received).toHaveLength(1)
    expect(await source.threadErrors()).toHaveLength(0)
  })

  it('treats 404 as a retriable thread error, not a final drop', async () => {
    const { fetchJSON, calls } = fakeFetch([
      { status: 200, body: [{ id: 1, subject: { url: "https://api.github.com/repos/a/b/issues/1" } }] },
      { status: 200, body: [{ id: 1, subject: { url: "https://api.github.com/repos/a/b/issues/1" } }] },
    ])
    const kv = MemoryKV()
    const source = new GitHubSource({
      config, token: 'tok', kv, fetchJSON,
      fetchThread: async () => ({ status: 404, number: 0, comments: [], state: 'open' }) as never,
      intake: async () => 'evaluated',
    })
    await source.pollOnce()
    expect(await source.threadErrors()).toHaveLength(1)
    expect(await kv.scan('thread-error/')).toHaveLength(1)
    // A second poll retries the same thread instead of dropping it.
    await source.pollOnce()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(await source.threadErrors()).toHaveLength(1)
  })

  it('reports an error after three failed polls in a row and clears on success', async () => {
    const failing = fakeFetch([{ status: 500, body: { message: 'boom' } }, { status: 500, body: {} }, { status: 500, body: {} }])
    const source = new GitHubSource({
      config, token: 'tok', kv: MemoryKV(), fetchJSON: failing.fetchJSON,
      fetchThread: async () => ({ number: 1, comments: [], state: 'open' }),
      intake: async () => 'evaluated',
    })
    await source.pollOnce()
    await source.pollOnce()
    expect(source.error()).toBeUndefined()
    await source.pollOnce()
    expect(source.error()).toBeDefined()
    const ok = fakeFetch([{ status: 304, body: {} }])
    const healthy = new GitHubSource({
      config, token: 'tok', kv: MemoryKV(), fetchJSON: ok.fetchJSON,
      fetchThread: async () => ({ number: 1, comments: [], state: 'open' }),
      intake: async () => 'evaluated',
    })
    await healthy.pollOnce()
    expect(healthy.error()).toBeUndefined()
  })
})

describe('github channel', () => {
  it('posts a reply as an issue comment with the token', async () => {
    const { fetchJSON, calls } = fakeFetch([{ status: 201, body: {} }])
    const channel = new GitHubChannel({ config, token: 'tok', fetchJSON })
    await channel.reply('github:a/b:1', 'working on it')
    expect(calls[0]?.url).toContain('/repos/a/b/issues/1/comments')
    expect(calls[0]?.init?.method).toBe('POST')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
  })
})
