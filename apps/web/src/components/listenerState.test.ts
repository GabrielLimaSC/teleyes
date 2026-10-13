import { describe, expect, it } from 'vitest'
import { listenerStatus } from '../test/listenerFixtures'
import { applyButtonLabel, describeListener, describeLoaded, settledToast } from './listenerState'

// 17:32 UTC is 14:32 in Brasília (the suite runs in America/Sao_Paulo).
const NOW = new Date(Date.UTC(2026, 8, 21, 20, 0, 0))

describe('describeListener', () => {
  it('idle and up to date: applied time and the new matches found in the history', () => {
    const view = describeListener(listenerStatus(), NOW)

    expect(view.label).toBe('Regras aplicadas')
    expect(view.detail).toBe('Aplicado às 14:32 — 3 matches novos no histórico.')
    expect(view).toMatchObject({ busy: false, needsApply: false, failed: false })
    expect(applyButtonLabel(view)).toBe('Aplicar regras')
  })

  it('says "nenhum match novo" and singular correctly', () => {
    expect(describeListener(listenerStatus({ new_matches: 0 }), NOW).detail).toContain(
      'nenhum match novo no histórico',
    )
    expect(describeListener(listenerStatus({ new_matches: 1 }), NOW).detail).toContain(
      '1 match novo no histórico',
    )
  })

  it('never invents a match count the listener did not report (boot)', () => {
    const view = describeListener(listenerStatus({ new_matches: null }), NOW)

    expect(view.detail).toBe('Aplicado às 14:32 — 2 fontes · 6 regras · 1 destinatário.')
  })

  it('flags a history that did not finish in some source', () => {
    const view = describeListener(listenerStatus({ scan_failures: 2 }), NOW)

    expect(view.detail).toContain('histórico incompleto em 2 fontes')
  })

  it('unapplied changes: warns, points at the old configuration, primary action', () => {
    const view = describeListener(listenerStatus({ has_unapplied_changes: true }), NOW)

    expect(view.label).toBe('Há mudanças ainda não aplicadas')
    expect(view.detail).toBe('O listener ainda usa a configuração carregada às 14:32.')
    expect(view.needsApply).toBe(true)
    expect(view.dot).toBe('var(--state-warn-dot)')
  })

  it('a listener that never loaded anything says so', () => {
    const view = describeListener(
      listenerStatus({ has_unapplied_changes: true, reload_applied_at: null }),
      NOW,
    )

    expect(view.detail).toBe('O listener ainda não carregou nenhuma configuração.')
  })

  it('pending: busy, with the request time; honest when the listener is not answering', () => {
    const online = describeListener(
      listenerStatus({ state: 'pending', reload_requested_at: '2026-09-21T18:00:00Z' }),
      NOW,
    )
    expect(online).toMatchObject({ label: 'Aguardando o listener…', busy: true })
    expect(online.detail).toBe('Pedido enviado às 15:00. O listener aplica em alguns segundos.')
    expect(applyButtonLabel(online)).toBe('Aplicando…')

    const offline = describeListener(
      listenerStatus({
        state: 'pending',
        reload_requested_at: '2026-09-21T18:00:00Z',
        listener_online: false,
      }),
      NOW,
    )
    expect(offline.detail).toContain('O listener não está respondendo; aplica assim que voltar.')
  })

  it('applying: busy', () => {
    const view = describeListener(listenerStatus({ state: 'applying' }), NOW)

    expect(view).toMatchObject({ label: 'Aplicando…', busy: true })
  })

  it('failed: names the class only, says the old configuration stays, offers a retry', () => {
    const view = describeListener(listenerStatus({ state: 'failed', error: 'ConnectionError' }), NOW)

    expect(view).toMatchObject({ label: 'Falha ao aplicar', failed: true, busy: false })
    expect(view.detail).toBe(
      'Não foi possível aplicar (ConnectionError). A configuração anterior continua ativa.',
    )
    expect(view.dot).toBe('var(--state-danger-dot)')
    expect(applyButtonLabel(view)).toBe('Tentar de novo')
  })

  it('a silent listener is neutral, not green', () => {
    const view = describeListener(listenerStatus({ listener_online: false }), NOW)

    expect(view.label).toBe('Listener sem sinal')
    expect(view.dot).toBe('var(--state-neutral-dot)')
  })

  it('never uses a color literal: only tokens', () => {
    for (const status of [
      listenerStatus(),
      listenerStatus({ state: 'failed', error: 'X' }),
      listenerStatus({ state: 'pending' }),
      listenerStatus({ has_unapplied_changes: true }),
    ]) {
      const view = describeListener(status, NOW)
      expect(view.color).toMatch(/^var\(--/)
      expect(view.dot).toMatch(/^var\(--/)
    }
  })
})

describe('describeLoaded', () => {
  it('is null until the listener reports its counts', () => {
    expect(describeLoaded(listenerStatus({ rules_loaded: null }))).toBeNull()
  })
})

describe('settledToast', () => {
  it('reports success with the history result', () => {
    expect(settledToast(listenerStatus({ new_matches: 2 }))).toEqual({
      message: 'Regras aplicadas — 2 matches novos no histórico.',
      tone: 'success',
    })
  })

  it('reports a failure as an error toast', () => {
    expect(settledToast(listenerStatus({ state: 'failed', error: 'TimeoutError' }))).toEqual({
      message: 'Não foi possível aplicar (TimeoutError). A configuração anterior continua ativa.',
      tone: 'error',
    })
  })
})
