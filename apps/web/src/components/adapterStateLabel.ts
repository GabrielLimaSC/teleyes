import type { AdapterState } from '../api/health'

export interface StateLabel {
  label: string
  /** Text color of the state word (a token, never a literal). */
  color: string
  /** The status dot beside it: a touch more saturated than the text in the
   * dark theme, so it has its own token. */
  dot: string
}

const NEUTRAL = { color: 'var(--state-neutral-text)', dot: 'var(--state-neutral-dot)' }
const GOOD = { color: 'var(--state-good-text)', dot: 'var(--state-good-dot)' }
const WARN = { color: 'var(--state-warn-text)', dot: 'var(--state-warn-dot)' }
const DANGER = { color: 'var(--state-danger-text)', dot: 'var(--state-danger-dot)' }

const TELEGRAM_STATE_LABELS: Record<AdapterState, StateLabel> = {
  not_configured: { label: 'Não configurado', ...NEUTRAL },
  connecting: { label: 'Conectando…', ...WARN },
  connected: { label: 'Conectado', ...GOOD },
  reconnecting: { label: 'Reconectando…', ...WARN },
  blocked: { label: 'Bloqueado', ...DANGER },
}

export function telegramStateLabel(state: AdapterState): StateLabel {
  return TELEGRAM_STATE_LABELS[state]
}

export function botStateLabel(state: 'configured' | 'not_configured'): StateLabel {
  return state === 'configured' ? { label: 'Configurado', ...GOOD } : { label: 'Não configurado', ...NEUTRAL }
}
