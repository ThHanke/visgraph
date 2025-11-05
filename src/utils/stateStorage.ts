import type { StateStorage } from "zustand/middleware";

let memoizedMemoryStorage: StateStorage | null = null;

function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

export function resolveStateStorage(): StateStorage {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  if (!memoizedMemoryStorage) {
    memoizedMemoryStorage = createMemoryStorage();
  }
  return memoizedMemoryStorage;
}
