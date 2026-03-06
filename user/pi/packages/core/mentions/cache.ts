export interface CacheStore<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): V;
  clear(): void;
}

export function createCache<K, V>(): CacheStore<K, V> {
  const store = new Map<K, V>();
  return {
    get(key) {
      return store.get(key);
    },
    set(key, value) {
      store.set(key, value);
      return value;
    },
    clear() {
      store.clear();
    },
  };
}

export function getOrSet<K, V>(
  cache: CacheStore<K, V>,
  key: K,
  load: () => V,
): V {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  return cache.set(key, load());
}
