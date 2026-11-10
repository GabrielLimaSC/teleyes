import { useEffect, useState } from 'react'
import { testRule } from '../api/rules'
import type { RuleTestInput } from '../api/rules'
import { parseTermList } from '../utils/termList'

export type RulePreview =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; total: number; windowDays: number }
  | { state: 'error' }

export const PREVIEW_DEBOUNCE_MS = 500

/**
 * S23-05: live "how many times would this rule have alerted" count, from the
 * read-only dry-run endpoint (`POST /rules/test`). Debounced so typing never
 * floods the API; only the newest request may update the state.
 */
export function useRulePreview(csrfToken: string | null, input: RuleTestInput, enabled: boolean): RulePreview {
  const [preview, setPreview] = useState<RulePreview>({ state: 'idle' })
  const { include_terms, exclude_terms = null, max_price_cents = null } = input
  const hasTerms = parseTermList(include_terms).length > 0

  useEffect(() => {
    if (!enabled || !hasTerms || csrfToken === null) {
      setPreview({ state: 'idle' })
      return
    }
    let cancelled = false
    setPreview({ state: 'loading' })
    const timer = window.setTimeout(() => {
      testRule(csrfToken, { include_terms, exclude_terms, max_price_cents })
        .then((result) => {
          if (cancelled) return
          if (typeof result.total_matched !== 'number') setPreview({ state: 'error' })
          else setPreview({ state: 'ready', total: result.total_matched, windowDays: result.window_days })
        })
        .catch(() => {
          if (!cancelled) setPreview({ state: 'error' })
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [csrfToken, include_terms, exclude_terms, max_price_cents, enabled, hasTerms])

  return preview
}

export function previewMessage(preview: RulePreview): string | null {
  if (preview.state === 'loading') return 'Calculando quantas vezes esta regra teria avisado…'
  if (preview.state !== 'ready') return null
  const { total, windowDays } = preview
  if (total === 0) return `Esta regra não teria avisado nenhuma vez nos últimos ${windowDays} dias.`
  return `Esta regra teria avisado ${total === 1 ? '1 vez' : `${total} vezes`} nos últimos ${windowDays} dias.`
}
