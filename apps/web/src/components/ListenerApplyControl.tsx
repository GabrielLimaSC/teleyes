import { HelpTip } from './HelpTip'
import type { ListenerStatus } from '../api/listener'
import { formatDayMonthTime } from '../utils/dates'
import { useFillOrigin } from '../utils/useFillOrigin'
import { applyButtonLabel, describeListener } from './listenerState'
import type { ListenerView } from './listenerState'
import './FillButton.css'
import './ListenerApplyControl.css'

/** The short note beside the button: what is true right now, in a few words. */
function stateNote(view: ListenerView, status: ListenerStatus): string {
  if (view.busy) return view.shortLabel.toLowerCase()
  if (view.failed) return 'falha ao aplicar'
  if (view.needsApply) return 'mudanças pendentes'
  if (view.shortLabel === 'Sem sinal') return 'leitor do Telegram sem sinal'
  return status.reload_applied_at === null
    ? 'configuração em uso'
    : `aplicado ${formatDayMonthTime(status.reload_applied_at)}`
}

/**
 * S13-06 / S21-02: "Aplicar regras". Rules, sources and recipients are read by
 * the listener process, not by the panel — this is where Gabriel tells it to
 * reload without asking anyone to restart a container. It lives in the page
 * header now: a status dot plus a small note ("aplicado 01/11 06:37") beside
 * the button, which turns primary while there is something to apply. State is
 * always a dot plus a word (never colour alone); the long sentence is the
 * tooltip, and a failure is announced (`role="alert"`).
 */
export function ListenerApplyControl({
  status,
  error,
  requesting,
  onApply,
  hideButton = false,
}: {
  status: ListenerStatus | null
  error: string | null
  requesting: boolean
  onApply: () => void
  /** S25-F4: the amber banner carries "Aplicar regras" while there is something to apply. */
  hideButton?: boolean
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
    <div className="listener-apply" aria-label="Aplicar regras ao leitor do Telegram" role="group">
      <HelpTip term="Aplicar regras" align="right">
        Depois de mudar regras, grupos ou destinatários, clique aqui para o teleyes passar a usar as mudanças.
      </HelpTip>
      <span className="listener-apply__state" title={view.detail}>
        <span className="listener-apply__dot" style={{ background: view.dot }} aria-hidden="true" />
        <span className="listener-apply__note" aria-live="polite">
          {stateNote(view, status)}
        </span>
      </span>
      {!hideButton && (
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
      )}
      {view.failed && (
        <p role="alert" className="listener-apply__detail">
          {view.detail}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="listener-apply__error">
          {error}
        </p>
      )}
    </div>
  )
}
