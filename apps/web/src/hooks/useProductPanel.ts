import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { usePrefersReducedMotion } from './useMediaQuery'

export type ProductPanelPhase = 'closed' | 'open' | 'closing'

const DEEP_LINK_PARAM = 'produto'
const EXIT_MS = 220
const EXIT_MS_REDUCED = 120

export interface ProductPanelController {
  /** `null` only while `phase === 'closed'` — kept during `closing` so the
   * exit animation still has content to fade out. */
  productKey: string | null
  phase: ProductPanelPhase
  /** Opens (or, if a panel is already open, switches to) a product. `trigger`
   * is the element focus returns to when the panel closes — the card's
   * "Abrir produto" button or title, per 07b. */
  open: (key: string, trigger: HTMLElement | null) => void
  close: () => void
}

/**
 * S14-08 (07b): shared open/close/deep-link/focus-return state for the
 * product panel — used identically by FeedPage and HistoricoPage so the
 * gatilho/transição rules are followed once, not reimplemented per page.
 *
 * `?produto=<key>` is the single source of truth for "is a panel open, and
 * which one": it is what survives F5 and what the browser back button
 * already undoes for free (`open`/`close` each touch `history` through
 * `setSearchParams`). `selfInitiatedRef` tells the URL-watching effect
 * below apart from an outside change (back/forward, or the initial deep
 * link on load): `open`/`close` already update `productKey`/`phase`
 * synchronously, so the effect seeing its own change would otherwise redo
 * the same work with a second, redundant close timeout.
 */
export function useProductPanel(): ProductPanelController {
  const [searchParams, setSearchParams] = useSearchParams()
  const reducedMotion = usePrefersReducedMotion()
  const urlKey = searchParams.get(DEEP_LINK_PARAM)

  const [productKey, setProductKey] = useState<string | null>(null)
  const [phase, setPhase] = useState<ProductPanelPhase>('closed')
  const triggerRef = useRef<HTMLElement | null>(null)
  const closeTimeoutRef = useRef<number | undefined>(undefined)
  const selfInitiatedRef = useRef(false)

  useLayoutEffect(() => {
    if (selfInitiatedRef.current) {
      selfInitiatedRef.current = false
      return
    }
    // External change: the browser back/forward buttons, or the deep link
    // already in the URL on first mount (F5, or a shared link).
    if (urlKey !== null) {
      window.clearTimeout(closeTimeoutRef.current)
      setProductKey(urlKey)
      setPhase('open')
      return
    }
    setPhase((current) => {
      if (current === 'closed') return current
      const duration = reducedMotion ? EXIT_MS_REDUCED : EXIT_MS
      window.clearTimeout(closeTimeoutRef.current)
      closeTimeoutRef.current = window.setTimeout(() => {
        setPhase('closed')
        setProductKey(null)
      }, duration)
      return 'closing'
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey])

  useLayoutEffect(() => () => window.clearTimeout(closeTimeoutRef.current), [])

  const open = useCallback(
    (key: string, trigger: HTMLElement | null) => {
      triggerRef.current = trigger
      window.clearTimeout(closeTimeoutRef.current)
      selfInitiatedRef.current = true
      setProductKey(key)
      setPhase('open')
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous)
          next.set(DEEP_LINK_PARAM, key)
          return next
        },
        { replace: false },
      )
    },
    [setSearchParams],
  )

  const close = useCallback(() => {
    selfInitiatedRef.current = true
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        next.delete(DEEP_LINK_PARAM)
        return next
      },
      { replace: false },
    )
    setPhase('closing')
    const duration = reducedMotion ? EXIT_MS_REDUCED : EXIT_MS
    window.clearTimeout(closeTimeoutRef.current)
    closeTimeoutRef.current = window.setTimeout(() => {
      setPhase('closed')
      setProductKey(null)
      const trigger = triggerRef.current
      triggerRef.current = null
      trigger?.focus()
    }, duration)
  }, [reducedMotion, setSearchParams])

  return { productKey, phase, open, close }
}
