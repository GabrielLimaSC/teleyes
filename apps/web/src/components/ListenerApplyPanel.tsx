import type { ListenerStatus } from '../api/listener'
import { useFillOrigin } from '../utils/useFillOrigin'
import { applyButtonLabel, describeListener } from './listenerState'
import './FillButton.css'
import './ListenerApplyPanel.css'

/**
 * S13-06: "Aplicar regras". Rules, sources and recipients are read by the
 * listener process, not by the panel — this is where Gabriel tells it to reload
 * without asking anyone to restart a container. State is always a dot plus a
 * word (never colour alone); the sentence beside it says what is really
 * happening, and a failure is announced (`role="alert"`).
 */
export function ListenerApplyPanel({
  status,
  error,
  requesting,
  onApply,
}: {
  status: ListenerStatus | null
  error: string | null
  requesting: boolean
  onApply: () => void
}) {
  const fillOrigin = useFillOrigin()

  if (status === null) {
    // Before the first answer there is nothing honest to say about the state.
    return error === null ? null : (
      <p role="alert" className="listener-apply__unknown">
        {error}
      </p>
    )
  }

  const view = describeListener(status)
  const busy = view.busy || requesting

  return (
    <section className="plane-pearl listener-apply" aria-label="Aplicar regras ao listener">
      <div className="listener-apply__text">
        <div className="listener-apply__state">
          <span className="listener-apply__dot" style={{ background: view.dot }} aria-hidden="true" />
          <span className="listener-apply__label" aria-live="polite">
            {view.label}
          </span>
        </div>
        <p className="listener-apply__detail" role={view.failed ? 'alert' : undefined}>
          {view.detail}
        </p>
        {error !== null && (
          <p role="alert" className="listener-apply__error">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        className={`plane-action fill-button listener-apply__button${
          view.needsApply ? '' : ' plane-action--secondary'
        }`}
        onClick={onApply}
        onPointerDown={fillOrigin}
        disabled={busy}
      >
        {applyButtonLabel({ ...view, busy })}
      </button>
    </section>
  )
}
