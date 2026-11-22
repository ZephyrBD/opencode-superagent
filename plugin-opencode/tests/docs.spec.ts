import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

describe('plugin README', () => {
  const readme = read('README.md')

  it('explains the plugin registration and the serving model', () => {
    expect(readme).toContain('"plugins"')
    expect(readme).toContain('opencode serve')
  })

  it('names the minimum configuration', () => {
    expect(readme).toContain('GITHUB_TOKEN')
    expect(readme).toContain('repository')
    expect(readme).toContain('allowedActors')
  })

  it('states the operator responsibilities', () => {
    expect(readme).toContain('Start narrow')
    expect(readme).toContain('噪音')
  })

  it('links only to files that exist', () => {
    const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]!.split('#')[0]!)
    for (const link of links) {
      if (/^[a-z]+:/.test(link)) continue
      expect(existsSync(resolve(ROOT, link)), `link target missing: ${link}`).toBe(true)
    }
  })

  it('references prompt files that exist', () => {
    for (const name of ['prompts/assessor.md', 'prompts/worker.md', 'prompts/shared.md']) {
      expect(existsSync(resolve(ROOT, name)), `${name} missing`).toBe(true)
    }
  })
})
