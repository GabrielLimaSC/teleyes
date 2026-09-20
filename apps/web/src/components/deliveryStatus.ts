import type { Delivery } from '../api/types'

export interface StatusPill {
  label: string
  dotColor: string
  background: string
  foreground: string
}

/**
 * Summarizes a match's `deliveries` (their real status strings from
 * packages/notifications/bot.py / apps/api/app/pipeline.py) into one status
 * pill. Text always accompanies the color (PRODUCT.md: "must not encode
 * delivery/match state by color alone").
 */
export function summarizeDeliveryStatus(deliveries: Delivery[]): StatusPill {
  if (deliveries.length === 0) {
    return { label: 'Sem destinatário', dotColor: 'var(--pill-neutral-dot)', background: 'var(--pill-neutral-bg)', foreground: 'var(--pill-neutral-fg)' }
  }
  if (deliveries.some((delivery) => delivery.status === 'sent')) {
    return { label: 'Entregue', dotColor: 'var(--pill-good-dot)', background: 'var(--pill-good-bg)', foreground: 'var(--pill-good-fg)' }
  }
  if (deliveries.some((delivery) => delivery.status === 'historical')) {
    return {
      label: 'Histórico — sem alerta',
      dotColor: 'var(--pill-info-dot)',
      background: 'var(--pill-info-bg)',
      foreground: 'var(--pill-info-fg)',
    }
  }
  if (deliveries.some((delivery) => delivery.status === 'grouped')) {
    return {
      label: 'Agrupado — mesma promoção já alertada',
      dotColor: 'var(--pill-info-dot)',
      background: 'var(--pill-info-bg)',
      foreground: 'var(--pill-info-fg)',
    }
  }
  if (deliveries.some((delivery) => delivery.status === 'failed')) {
    return { label: 'Falha no envio', dotColor: 'var(--pill-danger-dot)', background: 'var(--pill-danger-bg)', foreground: 'var(--pill-danger-fg)' }
  }
  if (deliveries.some((delivery) => delivery.status === 'not_allowlisted')) {
    return {
      label: 'Destinatário não autorizado',
      dotColor: 'var(--pill-warn-dot)',
      background: 'var(--pill-warn-bg)',
      foreground: 'var(--pill-warn-fg)',
    }
  }
  if (deliveries.every((delivery) => delivery.status === 'not_configured')) {
    return { label: 'Notificação desativada', dotColor: 'var(--pill-info-dot)', background: 'var(--pill-info-bg)', foreground: 'var(--pill-info-fg)' }
  }
  if (deliveries.some((delivery) => delivery.status === 'duplicate')) {
    return { label: 'Duplicado', dotColor: 'var(--pill-neutral-dot)', background: 'var(--pill-neutral-bg)', foreground: 'var(--pill-neutral-fg)' }
  }
  return { label: 'Pendente', dotColor: 'var(--pill-neutral-dot)', background: 'var(--pill-neutral-bg)', foreground: 'var(--pill-neutral-fg)' }
}
