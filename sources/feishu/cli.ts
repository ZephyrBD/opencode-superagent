import { execFile } from 'node:child_process'
import { DroppedConversationError, type FeishuCli, type FeishuItem } from './index.ts'

export type CliRunner = (command: string[]) => Promise<{ stdout: string; stderr: string; code: number }>

const run = (cliPath: string): CliRunner => command =>
  new Promise((resolve, reject) => {
    execFile(cliPath, command, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as { code?: number }).code ?? 1
        resolve({ stdout, stderr, code })
        return
      }
      resolve({ stdout, stderr, code: 0 })
    })
  })

/** The real FeishuCli: shells out to `lark-cli pull/reply`, maps 410 to a dropped conversation. */
export const cliFeishuCli = (cliPath = 'lark-cli', runner: CliRunner = run(cliPath)): FeishuCli => ({
  pull: async after => {
    const { stdout, code } = await runner(['pull', '--after', String(after), '--json'])
    if (code !== 0) throw new Error(`lark-cli pull failed: ${stdout.slice(0, 200)}`)
    return JSON.parse(stdout) as { me: string; items: FeishuItem[]; next: number }
  },
  reply: async (conversation, to, key, text) => {
    const { stderr, code } = await runner(['reply', '--conversation', conversation, '--to', to, '--key', key, '--text', text])
    if (code === 0) return
    if (stderr.includes('"code": 410') || stderr.includes('410')) throw new DroppedConversationError(stderr.slice(0, 200))
    throw new Error(`lark-cli reply failed: ${stderr.slice(0, 200)}`)
  },
  thread: async (conversation, root, after) => {
    const command = ['thread', '--conversation', conversation, '--root', root, '--json']
    if (after) command.push('--after', after)
    const { stdout, code } = await runner(command)
    if (code !== 0) throw new Error(`lark-cli thread failed: ${stdout.slice(0, 200)}`)
    return JSON.parse(stdout) as { items: FeishuItem[]; next?: string }
  },
})
