import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useModalMotion } from '../motion/modalMotion'
import { DIALOG_PRESET } from '../motion/waapi'
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  // S25-M1: scale 0.96 → 1 + fade in; the same, reversed, when the caller unmounts it.
  useModalMotion(backdropRef, dialogRef, DIALOG_PRESET)

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
    <div ref={backdropRef} className="confirm-dialog__backdrop" role="presentation" {...{ [CONFIRM_DIALOG_ATTR]: true }}>
      <div
        ref={dialogRef}
        tabIndex={-1}
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
