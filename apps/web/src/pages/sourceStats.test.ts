import { describe, expect, it } from 'vitest'
import { formatRelativeAgo } from '../utils/dates'
import { barScale, buildBars, buildKpis, sourceHue, sourceInitial } from './sourceStats'

const row = (daily: (number | null)[], matches = 0, last: string | null = null) => ({
  source_id: 1,
  name: 'A',
  active: true,
  daily: daily.map((evaluated, i) => ({ day: `2026-09-0${i + 1}`, evaluated })),
  matches,
  last_match_at: last,
})

describe('sourceStats', () => {
  it('keeps null as null in the bars and scales against the busiest day', () => {
    const activity = { days: 3, coverage_since: null, sources: [row([null, 5, 10])] }
    expect(barScale(activity)).toBe(10)
    expect(buildBars(activity.sources[0], 10).map((bar) => [bar.value, bar.ratio])).toEqual([
      [null, 0],
      [5, 0.5],
      [10, 1],
    ])
  })

  it('has no KPI figures without activity', () => {
    const kpis = buildKpis([], null)
    expect(kpis.evaluated.value).toBe('—')
    expect(kpis.matches.value).toBe('—')
    expect(kpis.lastMatch.at).toBeNull()
  })

  it('derives hue and initial deterministically', () => {
    expect(sourceHue(7)).toBe(sourceHue(7))
    expect(sourceHue(0)).toBeGreaterThanOrEqual(1)
    expect(sourceInitial(' ofertas')).toBe('O')
    expect(sourceInitial('')).toBe('?')
  })

  it('formats relative time', () => {
    const now = new Date('2026-09-20T12:00:00Z')
    expect(formatRelativeAgo('2026-09-20T11:59:39Z', now)).toBe('há 21s')
    expect(formatRelativeAgo('2026-09-20T11:55:00Z', now)).toBe('há 5 min')
    expect(formatRelativeAgo('2026-09-20T08:00:00Z', now)).toBe('há 4h')
    expect(formatRelativeAgo('2026-09-18T11:00:00Z', now)).toBe('há 2 dias')
  })
})
