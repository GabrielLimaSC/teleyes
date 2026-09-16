import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToast } from './useToast'

describe('useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with no toast', () => {
    const { result } = renderHook(() => useToast())
    expect(result.current.toast).toBeNull()
  })

  it('shows a toast with the message, a success tone by default, and an id', () => {
    const { result } = renderHook(() => useToast())

    act(() => result.current.showToast('Regra criada.'))

    expect(result.current.toast).toMatchObject({ message: 'Regra criada.', tone: 'success' })
  })

  it('supports an explicit error tone', () => {
    const { result } = renderHook(() => useToast())

    act(() => result.current.showToast('Não foi possível salvar.', 'error'))

    expect(result.current.toast).toMatchObject({ message: 'Não foi possível salvar.', tone: 'error' })
  })

  it('auto-dismisses after the given duration', () => {
    const { result } = renderHook(() => useToast(1000))

    act(() => result.current.showToast('Regra criada.'))
    expect(result.current.toast).not.toBeNull()

    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.toast).toBeNull()
  })

  it('dismiss() clears the toast immediately, before its timer fires', () => {
    const { result } = renderHook(() => useToast(1000))

    act(() => result.current.showToast('Regra criada.'))
    act(() => result.current.dismiss())

    expect(result.current.toast).toBeNull()
  })

  it('a second showToast() call resets the timer instead of stacking', () => {
    const { result } = renderHook(() => useToast(1000))

    act(() => result.current.showToast('Regra criada.'))
    act(() => vi.advanceTimersByTime(700))
    act(() => result.current.showToast('Regra atualizada.'))
    // Only 300ms left on a stale timer — if it weren't cleared, the toast
    // would vanish here even though the second call just reset it.
    act(() => vi.advanceTimersByTime(300))

    expect(result.current.toast).toMatchObject({ message: 'Regra atualizada.' })

    act(() => vi.advanceTimersByTime(700))
    expect(result.current.toast).toBeNull()
  })

  it('each toast gets a distinct id', () => {
    const { result } = renderHook(() => useToast())

    act(() => result.current.showToast('Primeiro'))
    const firstId = result.current.toast?.id
    act(() => result.current.showToast('Segundo'))
    const secondId = result.current.toast?.id

    expect(firstId).not.toBe(secondId)
  })
})
