import { useEffect, useState } from 'react'
import { previewRecipient } from '../api/recipients'
import type { PreviewParams } from '../api/recipients'
import type { RecipientPreview } from '../api/types'

export const PREVIEW_DEBOUNCE_MS = 300

export interface RecipientPreviewState {
  preview: RecipientPreview | null
  error: string | null
}

/**
 * S21-07: debounced `GET /recipients/preview`. A burst of chip clicks makes a
 * single request (the last one wins); `enabled=false` (invalid draft) makes
 * none. Stale answers are dropped, so a slow earlier request never overwrites
 * a newer one.
 */
export function useRecipientPreview(params: PreviewParams, enabled: boolean): RecipientPreviewState {
  const [state, setState] = useState<RecipientPreviewState>({ preview: null, error: null })
  const key = JSON.stringify([
    params.rules_mode,
    [...params.rule_ids].sort((a, b) => a - b),
    params.notify_target,
    params.notify_common,
  ])

  useEffect(() => {
    if (!enabled) return
    let stale = false
    const timer = window.setTimeout(() => {
      const [rules_mode, rule_ids, notify_target, notify_common] = JSON.parse(key) as [
        PreviewParams['rules_mode'],
        number[],
        boolean,
        boolean,
      ]
      previewRecipient({ rules_mode, rule_ids, notify_target, notify_common })
        .then((preview) => {
          if (!stale) setState({ preview, error: null })
        })
        .catch((failure: unknown) => {
          if (!stale) {
            setState({
              preview: null,
              error: failure instanceof Error ? failure.message : 'Não foi possível calcular a prévia.',
            })
          }
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [key, enabled])

  return enabled ? state : { preview: null, error: null }
}
