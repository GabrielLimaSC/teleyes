import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatClockMoment,
  formatDateTime,
  formatDayMonth,
  formatMatchedAt,
  isLater,
  isSameLocalDay,
  localDateStamp,
  parseApiDate,
} from './dates'

// 22:43 in Brasília on 2026-09-19 is 01:43 UTC on 2026-09-20 — the instant from
// the real-screen report (S13-01). vitest.config.ts pins TZ=America/Sao_Paulo.
const INSTANT_MS = Date.UTC(2026, 8, 20, 1, 43, 0)

describe('the suite really runs in America/Sao_Paulo (UTC-3)', () => {
  it('has a -3h local offset, so a UTC/local mix-up cannot pass by luck', () => {
    expect(process.env.TZ).toBe('America/Sao_Paulo')
    expect(new Date(INSTANT_MS).getTimezoneOffset()).toBe(180)
    expect(new Date(INSTANT_MS).getHours()).toBe(22)
    expect(new Date(INSTANT_MS).getDate()).toBe(19)
  })
})

describe('parseApiDate', () => {
  it('reads a string with Z as that UTC instant', () => {
    expect(parseApiDate('2026-09-20T01:43:00Z').getTime()).toBe(INSTANT_MS)
  })

  it('reads a string with NO zone as UTC, never as local (the S13-01 bug)', () => {
    // `new Date('2026-09-20T01:43:00')` is 04:43 UTC here: 3h off.
    expect(parseApiDate('2026-09-20T01:43:00').getTime()).toBe(INSTANT_MS)
    expect(parseApiDate('2026-09-20T01:43:00.123456').getTime()).toBe(INSTANT_MS + 123)
    expect(parseApiDate('2026-09-20 01:43:00').getTime()).toBe(INSTANT_MS)
  })

  it('honours an explicit offset', () => {
    expect(parseApiDate('2026-09-19T22:43:00-03:00').getTime()).toBe(INSTANT_MS)
    expect(parseApiDate('2026-09-19T22:43:00-0300').getTime()).toBe(INSTANT_MS)
    expect(parseApiDate('2026-09-20T04:43:00+03:00').getTime()).toBe(INSTANT_MS)
    expect(parseApiDate('2026-09-20T01:43:00.5Z').getTime()).toBe(INSTANT_MS + 500)
    expect(parseApiDate('2026-09-20T01:43:00z').getTime()).toBe(INSTANT_MS)
  })

  it('agrees on the same instant whatever spelling the API used', () => {
    const spellings = ['2026-09-20T01:43:00Z', '2026-09-20T01:43:00', '2026-09-19T22:43:00-03:00']
    const times = spellings.map((value) => parseApiDate(value).getTime())
    expect(new Set(times).size).toBe(1)
  })
})

describe('local presentation around midnight', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows 22:43 (not 01:43) for 01:43 UTC, and calls it the LOCAL day before', () => {
    const now = new Date(2026, 8, 19, 23, 0, 0) // local 19 Sep, 23:00 = 02:00 UTC on the 20th

    expect(formatMatchedAt('2026-09-20T01:43:00', now)).toBe('Hoje, 22:43')
    expect(formatMatchedAt('2026-09-20T01:43:00Z', now)).toBe('Hoje, 22:43')
  })

  it('says "Ontem" once local midnight has passed, even though UTC has not moved on a day', () => {
    const now = new Date(2026, 8, 20, 0, 30, 0) // local 20 Sep 00:30 = 03:30 UTC

    expect(formatMatchedAt('2026-09-20T01:43:00Z', now)).toBe('Ontem, 22:43')
  })

  it('a match at local 00:10 is "Hoje" although its UTC date is the same as yesterday evening', () => {
    const now = new Date(2026, 8, 20, 8, 0, 0)

    expect(formatMatchedAt('2026-09-20T03:10:00Z', now)).toBe('Hoje, 00:10') // 00:10 local
    expect(formatMatchedAt('2026-09-20T02:59:00Z', now)).toBe('Ontem, 23:59') // 23:59 local
  })

  it('compares calendar days in local time', () => {
    expect(isSameLocalDay(parseApiDate('2026-09-20T02:59:59Z'), parseApiDate('2026-09-19T15:00:00Z'))).toBe(true)
    expect(isSameLocalDay(parseApiDate('2026-09-20T03:00:00Z'), parseApiDate('2026-09-19T15:00:00Z'))).toBe(false)
  })

  it('formats the full local date and time', () => {
    expect(formatDateTime('2026-09-20T01:43:00')).toBe(new Date(2026, 8, 19, 22, 43, 0).toLocaleString('pt-BR'))
    expect(formatDateTime('2026-09-20T01:43:00')).toContain('19/09/2026')
    expect(formatDateTime('2026-09-20T01:43:00')).toContain('22:43')
  })

  it('names the CSV file by the local day, not the UTC day', () => {
    // local 19 Sep 22:43: `toISOString().slice(0, 10)` would say 2026-09-20.
    expect(localDateStamp(new Date(2026, 8, 19, 22, 43, 0))).toBe('2026-09-19')
    expect(localDateStamp(new Date(2026, 0, 5, 0, 5, 0))).toBe('2026-01-05')
  })
})

describe('isLater', () => {
  it('compares instants, not strings', () => {
    // As strings "…00Z" > "…00.5Z" ('Z' sorts after '.'), but 00.5s is later.
    expect(isLater('2026-09-20T01:43:00.5Z', '2026-09-20T01:43:00Z')).toBe(true)
    expect(isLater('2026-09-20T01:43:00Z', '2026-09-20T01:43:00.5Z')).toBe(false)
  })

  it('treats a zone-less and a Z value as the same instant', () => {
    expect(isLater('2026-09-20T01:43:00', '2026-09-20T01:43:00Z')).toBe(false)
    expect(isLater('2026-09-20T01:43:01', '2026-09-20T01:43:00Z')).toBe(true)
  })
})

describe('formatClockMoment (S13-06)', () => {
  // 17:32 UTC on 2026-09-21 is 14:32 in Brasília.
  const applied = '2026-09-21T17:32:00Z'

  it('says only the local clock time for a moment today', () => {
    const now = new Date(Date.UTC(2026, 8, 21, 20, 0, 0))
    expect(formatClockMoment(applied, now)).toBe('às 14:32')
  })

  it('adds the local day for another day, and reads a zone-less API value as UTC', () => {
    const now = new Date(Date.UTC(2026, 8, 23, 20, 0, 0))
    expect(formatClockMoment(applied, now)).toBe('em 21/09 às 14:32')
    expect(formatClockMoment('2026-09-21T17:32:00', now)).toBe('em 21/09 às 14:32')
  })
})

describe('formatDayMonth (S14-08)', () => {
  it('shows only DD/MM in the local zone, no year and no time', () => {
    // 01:43 UTC on 2026-09-20 is 19 Sep local (America/Sao_Paulo, UTC-3).
    expect(formatDayMonth('2026-09-20T01:43:00Z')).toBe('19/09')
    expect(formatDayMonth('2026-06-24T12:00:00Z')).toBe('24/06')
  })
})
