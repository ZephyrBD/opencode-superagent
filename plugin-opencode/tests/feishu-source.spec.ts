import { describe, expect, it } from 'vitest'
import { FeishuSource, DroppedConversationError, parseCliLine } from '../sources/feishu/index.ts'
import { cliFeishuCli, type CliRunner } from '../sources/feishu/cli.ts'
import { MemoryKV } from '../core/kv.ts'
import type { Trigger } from '../core/model.ts'

const item = (over: Record<string, unknown> = {}) => ({
  id: 'om_1',
  conversation: 'oc_chat1',
  thread: undefined,
  sender: { id: 'ou_zephyr', bot: false },
  mentions_me: true,
  text: 'please fix the login bug',
  at: 1700000000000,
  url: 'https://feishu.example/om_1',
  ...over,
})

const fakeCli = (items: unknown[] = []) => {
  const pulled: number[] = []
  const replies: Array<{ conversation: string; to: string; key: string; text: string }> = []
  return {
    pulled,
    replies,
    pull: async (after: number) => {
      pulled.push(after)
      return { me: 'ou_bot', items: items as never[], next: after + items.length }
    },
    reply: async (conversation: string, to: string, key: string, text: string) => {
      if (replies.some(r => r.key === key)) return
      replies.push({ conversation, to, key, text })
    },
    thread: async () => ({ items: [] }),
  }
}

const config = {
  chats: [{ id: 'oc_chat1', listen: 'mentions' as const }, { id: 'oc_chat2', listen: 'all' as const }],
  pollSeconds: 30,
}

describe('feishu cli parsing', () => {
  it('maps a 410 reply failure to a dropped conversation', async () => {
    const runner: CliRunner = async () => ({ stdout: '', stderr: '{"error": {"code": 410, "message": "gone"}}', code: 2 })
    const cli = cliFeishuCli('lark-cli', runner)
    await expect(cli.reply('oc_chat1', 'om_1', 'k', 'text')).rejects.toBeInstanceOf(DroppedConversationError)
  })

  it('parses a pull result line and knows dropped conversations', () => {
    expect(parseCliLine('{"me":"ou_bot","items":[],"next":5}')).toEqual({ me: 'ou_bot', items: [], next: 5 })
    expect(new DroppedConversationError('gone').dropped).toBe(true)
  })
})

describe('feishu source', () => {
  it('delivers mentions in listened chats as triggers', async () => {
    const received: Trigger[] = []
    const cli = fakeCli([
      item(),
      item({ id: 'om_2', conversation: 'oc_chat2', mentions_me: false, text: 'noise for all-listen chat' }),
      item({ id: 'om_3', conversation: 'oc_chat3', mentions_me: true, text: 'unlistened chat' }),
      item({ id: 'om_4', sender: { id: 'ou_bot', bot: true }, text: 'the agent itself' }),
    ])
    const source = new FeishuSource({
      config, cli, kv: MemoryKV(),
      intake: async t => {
        received.push(t)
        return 'evaluated'
      },
    })
    await source.pollOnce()
    expect(received.map(t => t.id)).toEqual(['trg_feishu_om_1', 'trg_feishu_om_2'])
    expect(received[0]).toMatchObject({
      source: 'feishu',
      actor: { id: 'ou_zephyr', bot: false },
      threadKey: 'feishu:oc_chat1:om_1',
    })
    expect(received[1]!.threadKey).toBe('feishu:oc_chat2:om_2')
  })

  it('does not replay messages across polls', async () => {
    const received: Trigger[] = []
    const cli = fakeCli([item()])
    const source = new FeishuSource({
      config, cli, kv: MemoryKV(),
      intake: async t => {
        received.push(t)
        return 'evaluated'
      },
    })
    await source.pollOnce()
    await source.pollOnce()
    expect(received).toHaveLength(1)
    expect(cli.pulled[0]).toBe(0)
  })

  it('replies once per key even when asked twice', async () => {
    const cli = fakeCli()
    const source = new FeishuSource({
      config, cli, kv: MemoryKV(),
      intake: async () => 'evaluated',
    })
    await source.reply('oc_chat1', 'om_1', 'ack-1', 'working on it')
    await source.reply('oc_chat1', 'om_1', 'ack-1', 'working on it')
    expect(cli.replies).toHaveLength(1)
  })

  it('drops a reply to a conversation Feishu no longer finds', async () => {
    const cli = fakeCli()
    cli.reply = async () => {
      throw new DroppedConversationError('conversation deleted')
    }
    const source = new FeishuSource({
      config, cli, kv: MemoryKV(),
      intake: async () => 'evaluated',
    })
    await source.reply('oc_chat1', 'om_1', 'ack-2', 'hello')
    expect(await source.droppedReplies()).toEqual([{ key: 'ack-2' }])
  })
})
