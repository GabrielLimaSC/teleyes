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
    return { label: 'Sem destinatário', dotColor: '#8a8a92', background: '#ececef', foreground: '#4b4b52' }
  }
  if (deliveries.some((delivery) => delivery.status === 'sent')) {
    return { label: 'Entregue', dotColor: '#1c8a4b', background: '#e2f5e9', foreground: '#166b3a' }
  }
  if (deliveries.some((delivery) => delivery.status === 'historical')) {
    return {
      label: 'Histórico — sem alerta',
      dotColor: '#5b5bd6',
      background: '#e9e9fb',
      foreground: '#3f3fb0',
    }
  }
  if (deliveries.some((delivery) => delivery.status === 'failed')) {
    return { label: 'Falha no envio', dotColor: '#b3261e', background: '#fbe4e2', foreground: '#8c1d17' }
  }
  if (deliveries.some((delivery) => delivery.status === 'not_allowlisted')) {
    return {
      label: 'Destinatário não autorizado',
      dotColor: '#8a6d00',
      background: '#fbf1d6',
      foreground: '#6b5400',
    }
  }
  if (deliveries.every((delivery) => delivery.status === 'not_configured')) {
    return { label: 'Notificação desativada', dotColor: '#5b5bd6', background: '#e9e9fb', foreground: '#3f3fb0' }
  }
  if (deliveries.some((delivery) => delivery.status === 'duplicate')) {
    return { label: 'Duplicado', dotColor: '#8a8a92', background: '#ececef', foreground: '#4b4b52' }
  }
  return { label: 'Pendente', dotColor: '#8a8a92', background: '#ececef', foreground: '#4b4b52' }
}
