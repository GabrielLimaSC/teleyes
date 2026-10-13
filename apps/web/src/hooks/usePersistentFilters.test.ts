import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePersistentFilters } from './usePersistentFilters'

interface Form {
  a: string
  b: string
}

const EMPTY: Form = { a: '', b: '' }
const KEY = 'test:persistent-filters'

function parse(raw: string): Form | null {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null) return null
    return { ...EMPTY, ...(value as Partial<Form>) }
  } catch {
    return null
  }
}

describe('usePersistentFilters', () => {
  afterEach(() => {
    window.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('starts from emptyValue when nothing is stored', () => {
    const { result } = renderHook(() => usePersistentFilters({ key: KEY, emptyValue: EMPTY, parse }))
    expect(result.current[0]).toEqual(EMPTY)
  })

  it('restores a previously stored value on the very first render', () => {
    window.sessionStorage.setItem(KEY, JSON.stringify({ a: 'x', b: 'y' }))
    const { result } = renderHook(() => usePersistentFilters({ key: KEY, emptyValue: EMPTY, parse }))
    expect(result.current[0]).toEqual({ a: 'x', b: 'y' })
  })

  it('falls back to emptyValue when the stored JSON is invalid', () => {
    window.sessionStorage.setItem(KEY, '{not json')
    const { result } = renderHook(() => usePersistentFilters({ key: KEY, emptyValue: EMPTY, parse }))
    expect(result.current[0]).toEqual(EMPTY)
  })

  it('setValue persists the new value, readable by a fresh mount', () => {
    const { result } = renderHook(() => usePersistentFilters({ key: KEY, emptyValue: EMPTY, parse }))
    act(() => result.current[1]({ a: 'z', b: '' }))
    expect(result.current[0]).toEqual({ a: 'z', b: '' })

    const { result: second } = renderHook(() => usePersistentFilters({ key: KEY, emptyValue: EMPTY, parse }))
    expect(second.current[0]).toEqual({ a: 'z', b: '' })
  })

  it('setValue accepts an updater function, same as useState', () => {
    const { result } = renderHook(() => usePersistentFilters({ key: KEY, emptyValue: EMPTY, parse }))
    act(() => result.current[1]((current) => ({ ...current, a: 'from-updater' })))
    expect(result.current[0]).toEqual({ a: 'from-updater', b: '' })
  })

  it('reset() clears both the in-memory value and what is stored', () => {
    const { result } = renderHook(() => usePersistentFilters({ key: KEY, emptyValue: EMPTY, parse }))
    act(() => result.current[1]({ a: 'x', b: 'y' }))
    act(() => result.current[2]())

    expect(result.current[0]).toEqual(EMPTY)
    expect(window.sessionStorage.getItem(KEY)).toBeNull()

    const { result: second } = renderHook(() => usePersistentFilters({ key: KEY, emptyValue: EMPTY, parse }))
    expect(second.current[0]).toEqual(EMPTY)
  })

  // S15-06 / S12-04 contract: a browser blocking storage makes every
  // `Storage` call throw — the page (here, the hook) must still work, just
  // without persistence.
  it('keeps working with no persistence when storage throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    const { result } = renderHook(() => usePersistentFilters({ key: KEY, emptyValue: EMPTY, parse }))
    expect(result.current[0]).toEqual(EMPTY)
  })

  it('keeps working with no persistence when storage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    const { result } = renderHook(() => usePersistentFilters({ key: KEY, emptyValue: EMPTY, parse }))
    expect(() => act(() => result.current[1]({ a: 'x', b: '' }))).not.toThrow()
    expect(result.current[0]).toEqual({ a: 'x', b: '' })
  })

  it('keeps working with no persistence when storage throws on remove (reset)', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    const { result } = renderHook(() => usePersistentFilters({ key: KEY, emptyValue: EMPTY, parse }))
    act(() => result.current[1]({ a: 'x', b: '' }))
    expect(() => act(() => result.current[2]())).not.toThrow()
    expect(result.current[0]).toEqual(EMPTY)
  })
})
