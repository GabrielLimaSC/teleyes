/**
 * S13-01 — the only place an API timestamp becomes a `Date`.
 *
 * The API stores UTC and (since S13-01) serialises every datetime as ISO 8601
 * with a trailing `Z`. A string without a zone (rows and payloads from before
 * that fix, or anything a future endpoint forgets to mark) is UTC too — but
 * `new Date('2026-09-20T01:43:00')` reads it as LOCAL time, which showed every
 * time 3h early in America/Sao_Paulo. So no other file may call `new Date(x)`
 * or `Date.parse` on an API field (`dates.guard.test.ts` enforces it): they all
 * go through `parseApiDate`.
 *
 * "Apresentado no fuso configurado": the app has no timezone setting, so the
 * configured zone is the viewer's own local one — every formatter below uses
 * the local getters / the runtime's default zone, never the UTC ones.
 */

// A zone designator at the end of a date-time: `Z`, `+03:00`, `-0300`, `+03`.
// Requires the time part (`T…`) first so a bare date's `-20` is never mistaken
// for an offset.
const ZONE_DESIGNATOR = /T[\d:.,]+(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/

/** Parse an API timestamp; a value with no zone is UTC (never local). */
export function parseApiDate(value: string): Date {
  const isoLike = value.trim().replace(' ', 'T')
  return new Date(ZONE_DESIGNATOR.test(isoLike) ? isoLike : `${isoLike}Z`)
}

/** Same calendar day in the viewer's local timezone. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * S10-06: "Hoje"/"Ontem" per the S10-05 comps, falling back to the full date
 * for anything older. `now` is overridable so no test depends on the wall
 * clock.
 */
export function formatMatchedAt(iso: string, now: Date = new Date()): string {
  const date = parseApiDate(iso)
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (isSameLocalDay(date, now)) return `Hoje, ${time}`

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameLocalDay(date, yesterday)) return `Ontem, ${time}`

  return date.toLocaleString('pt-BR')
}

/** Full local date and time, e.g. "20/09/2026, 22:43:00". */
export function formatDateTime(iso: string): string {
  return parseApiDate(iso).toLocaleString('pt-BR')
}

/** True when the API timestamp `a` is strictly later than `b` — compares instants, never strings. */
export function isLater(a: string, b: string): boolean {
  return parseApiDate(a).getTime() > parseApiDate(b).getTime()
}

/** `YYYY-MM-DD` of the LOCAL calendar day (`toISOString().slice(0, 10)` is the UTC day: tomorrow's date after 21h in UTC-3). */
export function localDateStamp(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}
