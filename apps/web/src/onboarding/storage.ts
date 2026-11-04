/**
 * S23-04: tiny per-viewer flags for the first-run experience ("Comece por aqui"
 * dismissed, "dica" closed). localStorage can be missing or throw (private
 * window, blocked site data), so every access is guarded and an in-memory map
 * keeps the flag for the rest of the page's life.
 */
const memory = new Map<string, string>()

export function readFlag(key: string): string | null {
  try {
    const stored = window.localStorage.getItem(key)
    if (stored !== null) return stored
  } catch {
    /* blocked storage: fall back to memory */
  }
  return memory.get(key) ?? null
}

export function writeFlag(key: string, value: string): void {
  memory.set(key, value)
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* blocked storage: memory only */
  }
}

/** Test helper: forget the in-memory copies. */
export function resetFlagMemory(): void {
  memory.clear()
}

export const FIRST_RUN_KEY = 'teleyes:first-run'
export const tipKey = (id: string): string => `teleyes:tip:${id}`
