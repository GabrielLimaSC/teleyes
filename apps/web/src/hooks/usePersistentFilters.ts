import { useState } from 'react'

/**
 * S15-06: small, generic sessionStorage-backed form state — used by
 * HistoricoPage so its filters survive a trip through NavCapsule (which
 * always links to `/historico` with no query string, so the URL alone can't
 * carry them) and an F5, but not a closed tab (sessionStorage, not
 * localStorage: a filter picked in one tab/session shouldn't silently follow
 * Gabriel into a new one).
 *
 * Every storage access is wrapped in try/catch — a browser that blocks
 * storage (Safari private mode, "block all cookies", `storage-blocked.spec.ts`)
 * must still let the page work exactly as before this task, just without the
 * persistence (same contract `theme.ts` and `AuthContext.tsx` already follow).
 */

export interface PersistentFiltersCodec<T> {
  /** sessionStorage key. */
  key: string
  /** Value used whenever nothing valid is stored. */
  emptyValue: T
  /**
   * Turns a raw stored string back into T, or `null` when it can't be
   * trusted (invalid JSON, not an object, an unknown field, a field with
   * the wrong type/shape). `null` makes the caller fall back to
   * `emptyValue` entirely — a partially-corrupt entry is never partially
   * trusted.
   */
  parse: (raw: string) => T | null
}

function readRaw(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, raw: string): void {
  try {
    window.sessionStorage.setItem(key, raw)
  } catch {
    // Blocked or full storage: the value still applies for this render,
    // it just won't survive navigating away and back.
  }
}

function removeRaw(key: string): void {
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    // Nothing to do: if writes already fail silently, there is nothing
    // persisted to remove either.
  }
}

function readInitial<T>(codec: PersistentFiltersCodec<T>): T {
  const raw = readRaw(codec.key)
  if (raw === null) return codec.emptyValue
  const parsed = codec.parse(raw)
  return parsed ?? codec.emptyValue
}

export type SetPersistentValue<T> = (next: T | ((current: T) => T)) => void

/**
 * Returns `[value, setValue, reset]`. `value` starts already restored from
 * storage (read once, synchronously, so the first render shows it — no
 * flash of empty filters before an effect runs). `setValue` accepts a plain
 * value or an updater, same as `useState`, and persists the result.
 * `reset()` clears storage AND brings `value` back to `emptyValue` — used by
 * "Limpar filtros" so a cleared form doesn't reappear on the next visit.
 */
export function usePersistentFilters<T>(
  codec: PersistentFiltersCodec<T>,
): [T, SetPersistentValue<T>, () => void] {
  const [value, setValueState] = useState<T>(() => readInitial(codec))

  const setValue: SetPersistentValue<T> = (next) => {
    setValueState((current) => {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(current) : next
      writeRaw(codec.key, JSON.stringify(resolved))
      return resolved
    })
  }

  const reset = () => {
    removeRaw(codec.key)
    setValueState(codec.emptyValue)
  }

  return [value, setValue, reset]
}
