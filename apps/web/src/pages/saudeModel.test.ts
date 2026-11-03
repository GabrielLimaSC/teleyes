import { describe, expect, it } from 'vitest'
import { availability, barKind, buildVerdict, coverageNote, formatAvailability, normalizeBuckets } from './saudeModel'
import type { ServiceView } from './saudeModel'

const b = (ok: number | null, total: number | null) => ({ hour: '2026-11-03T10:00:00Z', ok, total })

const view = (key: ServiceView['key'], tone: ServiceView['tone'], name: string = key): ServiceView => ({
  key,
  name,
  pill: '',
  tone,
})

describe('saudeModel', () => {
  it('classifies hours: ok, partial, down and unmeasured', () => {
    expect(barKind(b(60, 60))).toBe('ok')
    expect(barKind(b(59, 60))).toBe('partial')
    expect(barKind(b(0, 60))).toBe('down')
    expect(barKind(b(null, null))).toBe('none')
    expect(barKind(null)).toBe('none')
  })

  it('computes availability only from hours with data', () => {
    expect(availability([b(null, null), null])).toBeNull()
    expect(formatAvailability(null)).toBe('—')
    expect(availability([b(60, 60), b(null, null), b(30, 60)])).toBe(75)
  })

  it('never rounds a partial failure up to 100%', () => {
    expect(formatAvailability(99.96)).toBe('99,9%')
    expect(formatAvailability(100)).toBe('100%')
    expect(formatAvailability((59 / 60) * 100)).toBe('98,3%')
  })

  it('pads to 24 bars, oldest first', () => {
    const bars = normalizeBuckets([b(1, 1), b(1, 1)])
    expect(bars).toHaveLength(24)
    expect(bars[0]).toBeNull()
    expect(bars[23]).not.toBeNull()
  })

  it('builds the verdict', () => {
    const all = [
      view('telegram', 'good'),
      view('bot', 'good'),
      view('listener', 'good'),
      view('sse', 'good'),
      view('db', 'good'),
    ]
    expect(buildVerdict(all, false).title).toBe('Tudo funcionando')
    const demo = [view('telegram', 'neutral', 'Telegram'), view('bot', 'neutral', 'Bot'), ...all.slice(2)]
    const demoVerdict = buildVerdict(demo, true)
    expect(demoVerdict.title).toBe('Operando em demonstração')
    expect(demoVerdict.detail).toContain('3 de 5 serviços ativos')
    expect(buildVerdict(demo, false).title).toBe('Configuração incompleta')
    const down = [...all.slice(0, 3), view('sse', 'danger', 'Feed (SSE)'), all[4]]
    expect(buildVerdict(down, false).title).toBe('Atenção: Feed (SSE) fora')
  })

  it('shows the coverage note only while the window is not full', () => {
    const now = new Date('2026-11-03T12:00:00Z')
    expect(coverageNote('2026-11-03T08:00:00Z', 24, now)).toMatch(/^coletando desde \d\d:\d\d$/)
    expect(coverageNote('2026-11-01T08:00:00Z', 24, now)).toBeNull()
    expect(coverageNote(null, 24, now)).toBeNull()
  })
})
