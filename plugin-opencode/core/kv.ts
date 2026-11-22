/** Durable key/value storage the domain persists through. The plugin adapts OpenCode's `ctx.storage` onto this. */
export interface KV {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(prefix: string): Promise<{ key: string; value: unknown }[]>
}

export const MemoryKV = (): KV & { dump(): Map<string, unknown> } => {
  const map = new Map<string, unknown>()
  return {
    async get<T = unknown>(key: string) {
      return map.get(key) as T | undefined
    },
    async set(key: string, value: unknown) {
      map.set(key, structuredClone(value))
    },
    async remove(key: string) {
      map.delete(key)
    },
    async scan(prefix: string) {
      return [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }))
    },
    dump: () => map,
  }
}

/** Scopes one store to a key prefix, so an owner cannot touch another's keys. */
export const PrefixKV = (base: KV, prefix: string): KV => ({
  get: key => base.get(prefix + key),
  set: (key, value) => base.set(prefix + key, value),
  remove: key => base.remove(prefix + key),
  scan: async sub => {
    const rows = await base.scan(prefix + sub)
    return rows.map(row => ({ key: row.key.slice(prefix.length), value: row.value }))
  },
})
