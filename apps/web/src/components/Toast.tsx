import type { ToastState } from '../hooks/useToast'
import './GlassCard.css'
import './Toast.css'

export function Toast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  if (toast === null) return null

  return (
    <div className="toast-viewport">
      <div className={`glass-card toast toast--${toast.tone}`} role="status" aria-live="polite">
        <span className="toast__message">{toast.message}</span>
        <button type="button" className="toast__close" onClick={onDismiss} aria-label="Fechar notificação">
          ×
        </button>
      </div>
    </div>
  )
}
