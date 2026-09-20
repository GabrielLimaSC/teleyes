/**
 * S12-02: theme mechanism, independent of the palette.
 *
 * `<html data-theme="light|dark">` is what the stylesheets key on; the user's
 * preference is `system | light | dark` (default `system`), kept in
 * localStorage (every access in try/catch: the page must work without storage)
 * and mirrored on `<html data-theme-preference>`. With `system` the resolved
 * theme follows `prefers-color-scheme` live. The inline script in index.html
 * runs the same resolution BEFORE the first paint, so there is no flash; this
 * module takes over once the app is up.
 */

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'teleyes.theme'
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'Sistema',
  light: 'Claro',
  dark: 'Escuro',
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

export interface ThemeState {
  preference: ThemePreference
  resolved: ResolvedTheme
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  return THEME_PREFERENCES[(THEME_PREFERENCES.indexOf(current) + 1) % THEME_PREFERENCES.length]
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

export function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

function storePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Blocked or full storage: the choice still applies for this session.
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches
  } catch {
    return false
  }
}

/** Puts the theme on <html> and the browser chrome color (theme-color) in step
 * with it. The chrome color is a token (`--browser-chrome-color`), read after
 * the attribute is set so each theme supplies its own. */
function applyToDocument(state: ThemeState): void {
  const root = document.documentElement
  root.setAttribute('data-theme', state.resolved)
  root.setAttribute('data-theme-preference', state.preference)
  const chrome = getComputedStyle(root).getPropertyValue('--browser-chrome-color').trim()
  if (chrome === '') return
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta === null) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
  }
  meta.content = chrome
}

// ---- tiny external store, so every consumer sees the same state ----

type Listener = () => void
const listeners = new Set<Listener>()
let state: ThemeState | null = null
let detach: (() => void) | null = null

function compute(preference: ThemePreference): ThemeState {
  return { preference, resolved: resolveTheme(preference, systemPrefersDark()) }
}

function commit(next: ThemeState): void {
  if (state !== null && state.preference === next.preference && state.resolved === next.resolved) {
    applyToDocument(next)
    return
  }
  state = next
  applyToDocument(next)
  listeners.forEach((listener) => listener())
}

export function getThemeState(): ThemeState {
  if (state === null) {
    state = compute(readStoredPreference())
    applyToDocument(state)
  }
  return state
}

export function setThemePreference(preference: ThemePreference): void {
  storePreference(preference)
  commit(compute(preference))
}

function attach(): void {
  let media: MediaQueryList | null = null
  try {
    media = window.matchMedia(DARK_QUERY)
  } catch {
    media = null
  }
  // The OS theme changed: only matters while the preference is "system".
  const onSystemChange = () => {
    if (state !== null && state.preference === 'system') commit(compute('system'))
  }
  // Another tab changed the preference.
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) commit(compute(readStoredPreference()))
  }
  media?.addEventListener('change', onSystemChange)
  window.addEventListener('storage', onStorage)
  detach = () => {
    media?.removeEventListener('change', onSystemChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function subscribeTheme(listener: Listener): () => void {
  if (listeners.size === 0) attach()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      detach?.()
      detach = null
    }
  }
}

/** Test helper: forget everything and re-read storage on next use. */
export function resetThemeForTests(): void {
  detach?.()
  detach = null
  listeners.clear()
  state = null
}
