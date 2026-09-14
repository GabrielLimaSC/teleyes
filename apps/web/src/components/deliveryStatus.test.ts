import { describe, expect, it } from 'vitest'
import { summarizeDeliveryStatus } from './deliveryStatus'
import type { Delivery } from '../api/types'

function delivery(status: string): Delivery {
  return { id: 1, recipient_id: 1, status, delivered_at: null, created_at: '2026-01-01T00:00:00Z' }
}

describe('summarizeDeliveryStatus', () => {
  it('reports no recipient when there are no deliveries', () => {
    expect(summarizeDeliveryStatus([]).label).toBe('Sem destinatário')
  })

  it('prioritizes a successful delivery over other statuses', () => {
    const label = summarizeDeliveryStatus([delivery('failed'), delivery('sent')]).label
    expect(label).toBe('Entregue')
  })

  it('reports not_configured only when every delivery is not_configured', () => {
    expect(summarizeDeliveryStatus([delivery('not_configured')]).label).toBe('Notificação desativada')
    expect(summarizeDeliveryStatus([delivery('not_configured'), delivery('failed')]).label).toBe(
      'Falha no envio',
    )
  })

  it('reports the historical label for a match matched without a retroactive alert (S6-02)', () => {
    expect(summarizeDeliveryStatus([delivery('historical')]).label).toBe('Histórico — sem alerta')
  })

  it('reports the grouped label for a match never notified because another source already alerted the same promotion (S7-11)', () => {
    expect(summarizeDeliveryStatus([delivery('grouped')]).label).toBe(
      'Agrupado — mesma promoção já alertada',
    )
  })

  it('never encodes state by color alone — every pill carries a label', () => {
    for (const status of [
      'sent',
      'failed',
      'not_allowlisted',
      'not_configured',
      'duplicate',
      'historical',
      'grouped',
      'weird',
    ]) {
      const pill = summarizeDeliveryStatus([delivery(status)])
      expect(pill.label.length).toBeGreaterThan(0)
      expect(pill.dotColor.length).toBeGreaterThan(0)
    }
  })
})
