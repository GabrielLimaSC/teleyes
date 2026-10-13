/// <reference types="node" />
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_STORAGE_KEY,
  getThemeState,
  nextThemePreference,
  readStoredPreference,
  resetThemeForTests,
  resolveTheme,
  setThemePreference,
  subscribeTheme,
} from './theme'

/** A controllable matchMedia: `setDark(true)` fires the registered listeners. */
function installMatchMedia(initialDark: boolean) {
  let dark = initialDark
  const listeners = new Set<() => void>()
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes('dark') ? dark : false
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  return {
    setDark(value: boolean) {
      dark = value
      listeners.forEach((listener) => listener())
    },
  }
}

const root = () => document.documentElement

beforeEach(() => {
  window.localStorage.clear()
  root().removeAttribute('data-theme')
  root().removeAttribute('data-theme-preference')
  resetThemeForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('theme resolution', () => {
  it('cycles system → light → dark → system', () => {
    expect(nextThemePreference('system')).toBe('light')
    expect(nextThemePreference('light')).toBe('dark')
    expect(nextThemePreference('dark')).toBe('system')
  })

  it('resolves "system" through the OS and leaves explicit choices alone', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('theme store — the three paths', () => {
  it('1. defaults to "system" and follows prefers-color-scheme, live', () => {
    const media = installMatchMedia(true)
    const seen: string[] = []
    const unsubscribe = subscribeTheme(() => seen.push(getThemeState().resolved))

    expect(getThemeState()).toEqual({ preference: 'system', resolved: 'dark' })
    expect(root().getAttribute('data-theme')).toBe('dark')
    expect(root().getAttribute('data-theme-preference')).toBe('system')

    media.setDark(false)
    expect(getThemeState().resolved).toBe('light')
    expect(root().getAttribute('data-theme')).toBe('light')
    expect(seen).toEqual(['light'])
    unsubscribe()
  })

  it('2. an explicit choice wins over the OS, is stored, and survives a fresh start', () => {
    const media = installMatchMedia(false)
    const unsubscribe = subscribeTheme(() => {})

    setThemePreference('dark')
    expect(getThemeState()).toEqual({ preference: 'dark', resolved: 'dark' })
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(root().getAttribute('data-theme')).toBe('dark')

    // The OS flipping does not matter once the user chose.
    media.setDark(true)
    media.setDark(false)
    expect(getThemeState().resolved).toBe('dark')
    unsubscribe()

    // A page reload: nothing in memory, the stored choice comes back.
    resetThemeForTests()
    expect(readStoredPreference()).toBe('dark')
    expect(getThemeState()).toEqual({ preference: 'dark', resolved: 'dark' })
  })

  it('3. blocked storage never breaks it: reads fall back to system, writes are swallowed', () => {
    installMatchMedia(true)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    expect(readStoredPreference()).toBe('system')
    expect(getThemeState()).toEqual({ preference: 'system', resolved: 'dark' })

    expect(() => setThemePreference('light')).not.toThrow()
    // Not persisted, but it applies for this session.
    expect(getThemeState()).toEqual({ preference: 'light', resolved: 'light' })
    expect(root().getAttribute('data-theme')).toBe('light')
  })

  it('ignores garbage in storage', () => {
    installMatchMedia(false)
    window.localStorage.setItem(THEME_STORAGE_KEY, 'solarized')
    expect(readStoredPreference()).toBe('system')
  })

  it('picks up a change made in another tab', () => {
    installMatchMedia(false)
    const unsubscribe = subscribeTheme(() => {})
    expect(getThemeState().resolved).toBe('light')

    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }))

    expect(getThemeState()).toEqual({ preference: 'dark', resolved: 'dark' })
    unsubscribe()
  })
})

describe('index.html pre-paint script', () => {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const html = readFileSync(path.join(webRoot, 'index.html'), 'utf8')
  const materials = readFileSync(path.join(webRoot, 'src/styles/materials.css'), 'utf8')

  it('runs before any stylesheet or module and uses the same storage key', () => {
    const scriptAt = html.indexOf('<script>')
    expect(scriptAt).toBeGreaterThan(-1)
    expect(scriptAt).toBeLessThan(html.indexOf('rel="stylesheet"'))
    expect(scriptAt).toBeLessThan(html.indexOf('type="module"'))
    expect(html).toContain(`'${THEME_STORAGE_KEY}'`)
    expect(html).toContain("setAttribute('data-theme', resolved)")
  })

  it('carries the same browser-chrome colors as the tokens', () => {
    const inline = html.match(/resolved === 'dark' \? '(#[0-9a-f]{6})' : '(#[0-9a-f]{6})'/)
    expect(inline).not.toBeNull()
    const [, dark, light] = inline!
    expect(materials).toMatch(new RegExp(String.raw`:root \{[^}]*--browser-chrome-color: ${light};`))
    expect(materials).toMatch(new RegExp(String.raw`\[data-theme='dark'\] \{[^}]*--browser-chrome-color: ${dark};`))
  })
})
