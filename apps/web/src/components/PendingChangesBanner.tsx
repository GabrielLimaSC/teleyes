import { useEffect, useState } from 'react'
import type { ListenerStatus } from '../api/listener'
import { useFillOrigin } from '../utils/useFillOrigin'
import { applyButtonLabel, describeListener } from './listenerState'
import { summarizePending } from './pendingChanges'
import './FillButton.css'
import './PendingChangesBanner.css'

/** Leaving animation length; matches `--chrome-spring-duration`'s order of magnitude. */
const LEAVE_MS = 260

/** S25-F4: whether the amber strip is showing. A failed apply keeps its own
 * retry button in the header instead (the failure text lives there). */
export function showsPendingBanner(status: ListenerStatus | null): boolean {
  return status !== null && status.has_unapplied_changes && !describeListener(status).failed
}

/**
 * S25-F4 (screens B3 / 15 / 17): the amber strip between the Regras title and
 * the table — "N mudanças não aplicadas · preço-alvo de X e nova regra Y" with
 * "Aplicar regras" in the highlight. Appears and leaves with the chrome spring
 * (no hard cut). There is deliberately no "Descartar": the listener only keeps
 * a light snapshot (names and a few fields), which cannot restore a deleted
 * rule with its history, snoozes and recipients.
 */
export function PendingChangesBanner({
  status,
  requesting,
  onApply,
}: {
  status: ListenerStatus | null
  requesting: boolean
  onApply: () => void
}) {
  const fillOrigin = useFillOrigin()
  const visible = showsPendingBanner(status)
  const [mounted, setMounted] = useState(visible)
  // Kept while the strip leaves, so it does not blank out mid-animation.
  const [kept, setKept] = useState(status)
  if (visible && kept !== status) setKept(status)

  useEffect(() => {
    if (visible) {
      setMounted(true)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  const shown = visible ? status : kept
  if (!(visible || mounted) || shown === null) return null

  const view = describeListener(shown)
  const busy = view.busy || requesting
  const summary = summarizePending(shown.unapplied_changes ?? [])

  return (
    <div
      className="plane-glass pending-banner"
      data-leaving={visible ? undefined : 'true'}
      role="group"
      aria-label="Mudanças não aplicadas"
    >
      <p className="pending-banner__text" aria-live="polite">
        <strong>{summary.title}</strong>
        {summary.detail && <span> · {summary.detail}. </span>}
        <span className="pending-banner__note">As ofertas já salvas ainda usam as regras antigas.</span>
      </p>
      <button
        type="button"
        className="plane-action fill-button pending-banner__button"
        onClick={onApply}
        onPointerDown={fillOrigin}
        disabled={busy}
      >
        {applyButtonLabel({ ...view, busy })}
      </button>
    </div>
  )
}
