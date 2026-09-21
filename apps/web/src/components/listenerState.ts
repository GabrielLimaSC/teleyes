import type { ListenerStatus } from '../api/listener'
import { formatClockMoment } from '../utils/dates'
import type { StateLabel } from './adapterStateLabel'

/**
 * S13-06: one reading of the listener status, shared by the "Aplicar regras"
 * panel (Regras) and the Listener tile (Saúde) so they never disagree.
 * Pure: `now` only decides "às 14:32" versus "em 20/09 às 14:32".
 */
export interface ListenerView extends StateLabel {
  /** The same state in a few words, for the narrow Saúde tile. */
  shortLabel: string
  /** A request is in flight: the button is disabled and reads "Aplicando…". */
  busy: boolean
  /** The apply button is the primary action (something to apply, or a failure to retry). */
  needsApply: boolean
  failed: boolean
  detail: string
}

const NEUTRAL = { color: 'var(--state-neutral-text)', dot: 'var(--state-neutral-dot)' }
const GOOD = { color: 'var(--state-good-text)', dot: 'var(--state-good-dot)' }
const WARN = { color: 'var(--state-warn-text)', dot: 'var(--state-warn-dot)' }
const DANGER = { color: 'var(--state-danger-text)', dot: 'var(--state-danger-dot)' }

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

/** "3 fontes · 6 regras · 2 destinatários", or `null` if the listener never reported. */
export function describeLoaded(status: ListenerStatus): string | null {
  const { sources_loaded: sources, rules_loaded: rules, recipients_loaded: recipients } = status
  if (sources === null || rules === null || recipients === null) return null
  return [
    plural(sources, 'fonte', 'fontes'),
    plural(rules, 'regra', 'regras'),
    plural(recipients, 'destinatário', 'destinatários'),
  ].join(' · ')
}

export function describeHistory(status: ListenerStatus): string {
  const found = status.new_matches
  let text: string
  if (found === null) text = describeLoaded(status) ?? 'configuração carregada'
  else if (found === 0) text = 'nenhum match novo no histórico'
  else text = `${plural(found, 'match novo', 'matches novos')} no histórico`
  const failures = status.scan_failures ?? 0
  if (failures > 0) {
    text += ` · histórico incompleto em ${plural(failures, 'fonte', 'fontes')}`
  }
  return text
}

export function describeListener(status: ListenerStatus, now: Date = new Date()): ListenerView {
  const appliedAt =
    status.reload_applied_at === null ? null : formatClockMoment(status.reload_applied_at, now)

  if (status.state === 'applying') {
    return {
      label: 'Aplicando…',
      shortLabel: 'Aplicando…',
      ...WARN,
      busy: true,
      needsApply: true,
      failed: false,
      detail: 'Relendo fontes, regras e destinatários e conferindo o histórico.',
    }
  }

  if (status.state === 'pending') {
    const requested =
      status.reload_requested_at === null
        ? 'Pedido enviado.'
        : `Pedido enviado ${formatClockMoment(status.reload_requested_at, now)}.`
    return {
      label: 'Aguardando o listener…',
      shortLabel: 'Aguardando…',
      ...WARN,
      busy: true,
      needsApply: true,
      failed: false,
      detail: status.listener_online
        ? `${requested} O listener aplica em alguns segundos.`
        : `${requested} O listener não está respondendo; aplica assim que voltar.`,
    }
  }

  if (status.state === 'failed') {
    const cause = status.error === null ? '' : ` (${status.error})`
    return {
      label: 'Falha ao aplicar',
      shortLabel: 'Falha ao aplicar',
      ...DANGER,
      busy: false,
      needsApply: true,
      failed: true,
      detail: `Não foi possível aplicar${cause}. A configuração anterior continua ativa.`,
    }
  }

  if (status.has_unapplied_changes) {
    return {
      label: 'Há mudanças ainda não aplicadas',
      shortLabel: 'Mudanças pendentes',
      ...WARN,
      busy: false,
      needsApply: true,
      failed: false,
      detail:
        appliedAt === null
          ? 'O listener ainda não carregou nenhuma configuração.'
          : `O listener ainda usa a configuração carregada ${appliedAt}.`,
    }
  }

  if (!status.listener_online) {
    return {
      label: 'Listener sem sinal',
      shortLabel: 'Sem sinal',
      ...NEUTRAL,
      busy: false,
      needsApply: false,
      failed: false,
      detail: 'O listener não respondeu ao painel há algum tempo. Confira se o serviço está rodando.',
    }
  }

  return {
    label: 'Regras aplicadas',
    shortLabel: 'Aplicado',
    ...GOOD,
    busy: false,
    needsApply: false,
    failed: false,
    detail: appliedAt === null ? 'Configuração em uso.' : `Aplicado ${appliedAt} — ${describeHistory(status)}.`,
  }
}

/** The apply button's label for a view. */
export function applyButtonLabel(view: ListenerView): string {
  if (view.busy) return 'Aplicando…'
  return view.failed ? 'Tentar de novo' : 'Aplicar regras'
}

/** The toast shown when a request ends: its text and tone. */
export function settledToast(status: ListenerStatus): { message: string; tone: 'success' | 'error' } {
  if (status.state === 'failed') {
    const cause = status.error === null ? '' : ` (${status.error})`
    return {
      message: `Não foi possível aplicar${cause}. A configuração anterior continua ativa.`,
      tone: 'error',
    }
  }
  return { message: `Regras aplicadas — ${describeHistory(status)}.`, tone: 'success' }
}
