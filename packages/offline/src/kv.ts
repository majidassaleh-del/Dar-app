/** Minimal async key–value store: AsyncStorage / MMKV / SQLite on mobile, IndexedDB on web, memory in tests. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys starting with prefix, in any order. */
  keys(prefix: string): Promise<string[]>;
}

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  async get(key: string) { return this.data.get(key) ?? null; }
  async set(key: string, value: string) { this.data.set(key, value); }
  async delete(key: string) { this.data.delete(key); }
  async keys(prefix: string) { return [...this.data.keys()].filter((k) => k.startsWith(prefix)); }
}
