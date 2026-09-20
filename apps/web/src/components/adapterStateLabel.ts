import type { AdapterState } from '../api/health'

export interface StateLabel {
  label: string
  color: string
}

const TELEGRAM_STATE_LABELS: Record<AdapterState, StateLabel> = {
  not_configured: { label: 'Não configurado', color: 'var(--pill-neutral-dot)' },
  connecting: { label: 'Conectando…', color: 'var(--pill-warn-dot)' },
  connected: { label: 'Conectado', color: 'var(--pill-good-dot)' },
  reconnecting: { label: 'Reconectando…', color: 'var(--pill-warn-dot)' },
  blocked: { label: 'Bloqueado', color: 'var(--pill-danger-dot)' },
}

export function telegramStateLabel(state: AdapterState): StateLabel {
  return TELEGRAM_STATE_LABELS[state]
}

export function botStateLabel(state: 'configured' | 'not_configured'): StateLabel {
  return state === 'configured'
    ? { label: 'Configurado', color: 'var(--pill-good-dot)' }
    : { label: 'Não configurado', color: 'var(--pill-neutral-dot)' }
}
