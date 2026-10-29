import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import './ConfirmDialog.css'

/** Marker other overlays (ProductPanel's Esc / click-outside) use to leave
 * events alone while a confirmation is open. */
export const CONFIRM_DIALOG_ATTR = 'data-confirm-dialog'

/**
 * S20-01: modal confirmation for destructive actions. Focus starts on the
 * safe button ("Cancelar"); Esc cancels. Rendered in a portal so no
 * `overflow`/stacking context of the caller can clip it.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busyLabel = 'Excluindo…',
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel: string
  /** Shown on the confirm button while `busy`; defaults to the delete wording. */
  busyLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel])

  return createPortal(
    <div className="confirm-dialog__backdrop" role="presentation" {...{ [CONFIRM_DIALOG_ATTR]: true }}>
      <div
        className="plane-pearl confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{title}</h2>
        <p className="confirm-dialog__body">{message}</p>
        <div className="confirm-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="plane-action plane-action--secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="plane-action plane-action--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
