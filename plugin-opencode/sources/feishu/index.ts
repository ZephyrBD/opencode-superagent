import type { KV } from '../../core/kv.ts'
import type { Trigger } from '../../core/model.ts'

/** One Feishu message as `lark-cli pull` prints it. */
export interface FeishuItem {
  id: string
  conversation: string
  thread?: string
  sender: { id: string; bot: boolean }
  mentions_me: boolean
  text: string
  at: number
  url: string
}

export interface FeishuConfig {
  chats: Array<{ id: string; listen: 'mentions' | 'all' }>
  pollSeconds: number
}

export interface FeishuCli {
  pull(after: number): Promise<{ me: string; items: FeishuItem[]; next: number }>
  reply(conversation: string, to: string, key: string, text: string): Promise<void>
  thread(conversation: string, root: string, after?: string): Promise<{ items: FeishuItem[]; next?: string }>
}

export const parseCliLine = (line: string): unknown => JSON.parse(line)

/** Feishu answers this when the conversation was deleted: the message can never be delivered. */
export class DroppedConversationError extends Error {
  readonly dropped = true
  constructor(message: string) {
    super(message)
    this.name = 'DroppedConversationError'
  }
}

export interface FeishuSourceDeps {
  config: FeishuConfig
  cli: FeishuCli
  kv: KV
  intake(trigger: Trigger): Promise<string>
}

/**
 * The Feishu Source: polls `lark-cli pull`, translates each listened chat's message into a
 * Trigger keyed by its thread root, and remembers its cursor and reply keys in KV.
 */
export class FeishuSource {
  private readonly config: FeishuConfig
  private readonly cli: FeishuCli
  private readonly kv: KV
  private readonly intake: FeishuSourceDeps['intake']

  constructor(deps: FeishuSourceDeps) {
    this.config = deps.config
    this.cli = deps.cli
    this.kv = deps.kv
    this.intake = deps.intake
  }

  /** Replies Feishu can never receive (deleted conversation): kept so they never queue again. */
  async droppedReplies(): Promise<Array<{ key: string }>> {
    return (await this.kv.scan('dropped-reply/')).map(row => ({ key: (row.value as { key: string }).key }))
  }

  async pollOnce(): Promise<'ok' | 'unchanged'> {
    const cursor = (await this.kv.get<number>('cursor')) ?? 0
    const result = await this.cli.pull(cursor)
    let delivered = 0
    for (const message of result.items) {
      if (message.sender.id === result.me) continue
      const chat = this.config.chats.find(entry => entry.id === message.conversation)
      if (!chat) continue
      if (chat.listen === 'mentions' && !message.mentions_me) continue
      const seenKey = `seen/${message.id}`
      if (await this.kv.get(seenKey)) continue
      const root = message.thread ?? message.id
      const trigger: Trigger = {
        id: `trg_feishu_${message.id}`,
        source: 'feishu',
        actor: { id: message.sender.id, bot: message.sender.bot },
        text: message.text,
        url: message.url,
        at: message.at,
        threadKey: `feishu:${message.conversation}:${root}`,
      }
      await this.intake(trigger)
      await this.kv.set(seenKey, true)
      delivered += 1
    }
    if (result.next !== cursor) await this.kv.set('cursor', result.next)
    return delivered > 0 || result.items.length > 0 ? 'ok' : 'unchanged'
  }

  /** Sends a reply; one key goes out once, ever. A deleted conversation drops the message for good. */
  async reply(conversation: string, to: string, key: string, text: string): Promise<void> {
    const keyRecord = `reply-key/${key}`
    if (await this.kv.get(keyRecord)) return
    if (await this.kv.get(`dropped-reply/${key}`)) return
    try {
      await this.cli.reply(conversation, to, key, text)
    } catch (error) {
      if (error instanceof DroppedConversationError) {
        await this.kv.set(`dropped-reply/${key}`, { key, reason: error.message })
        return
      }
      throw error
    }
    await this.kv.set(keyRecord, { key, at: Date.now() })
  }
}
