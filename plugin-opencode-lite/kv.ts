/**
 * The plugin's KV port. The full version shares the same shape (plugin-opencode/core/kv.ts),
 * so the engine and executor stay storage-agnostic and tests can use an in-memory map.
 */
export interface KV {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(prefix: string): Promise<Array<{ key: string; value: unknown }>>
}

export const memoryKV = (): KV & { dump(): Map<string, unknown> } => {
  const map = new Map<string, unknown>()
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    set: async (key, value) => {
      map.set(key, structuredClone(value))
    },
    remove: async key => {
      map.delete(key)
    },
    scan: async prefix =>
      [...map.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, value })),
    dump: () => map,
  }
}
