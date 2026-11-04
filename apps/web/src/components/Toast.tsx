import type { ToastState } from '../hooks/useToast'
import './GlassCard.css'
import './Toast.css'

/**
 * The live region stays mounted even with no toast: screen readers announce
 * text *added* to an existing region far more reliably than a region that
 * appears together with its text (S23-02).
 */
export function Toast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  return (
    <div className="toast-viewport" role="status" aria-live="polite" aria-atomic="true">
      {toast !== null && (
        <div className={`glass-card toast toast--${toast.tone}`}>
          <span className="toast__message">{toast.message}</span>
          <button type="button" className="toast__close" onClick={onDismiss} aria-label="Fechar notificação">
            ×
          </button>
        </div>
      )}
    </div>
  )
}
