import type { Source, SourceActivity, SourcesActivity } from '../api/types'
import { isLater } from '../utils/dates'
import { formatCount } from '../utils/savings'

export interface FontesKpis {
  active: { value: string; sub: string }
  evaluated: { value: string; sub: string }
  matches: { value: string; sub: string }
  lastMatch: { at: string | null; source: string | null }
}

/** Evaluations of the most recent day in the series (the API only has daily buckets); null when nothing was measured. */
export function evaluatedToday(activity: SourcesActivity | null): number | null {
  if (activity === null) return null
  let total: number | null = null
  for (const row of activity.sources) {
    const today = row.daily[row.daily.length - 1]
    if (today?.evaluated != null) total = (total ?? 0) + today.evaluated
  }
  return total
}

/** `formatSince` renders the API's `coverage_since` timestamp for display. */
export function buildKpis(
  sources: Source[],
  activity: SourcesActivity | null,
  formatSince: (iso: string) => string = (iso) => iso,
): FontesKpis {
  const active = sources.filter((source) => source.active).length
  const paused = sources.length - active
  const rows = activity?.sources ?? []
  const evaluated = evaluatedToday(activity)
  const since =
    activity?.coverage_since != null ? `coletando desde ${formatSince(activity.coverage_since)}` : 'coletando'

  const totalMatches = rows.reduce((sum, row) => sum + row.matches, 0)
  const leader = rows.reduce<SourceActivity | null>(
    (best, row) => (row.matches > (best?.matches ?? 0) ? row : best),
    null,
  )

  let last: SourceActivity | null = null
  for (const row of rows) {
    if (row.last_match_at === null) continue
    if (last === null || isLater(row.last_match_at, last.last_match_at ?? row.last_match_at)) last = row
  }

  return {
    active: {
      value: `${active} de ${sources.length}`,
      sub: paused === 0 ? 'nenhuma pausada' : paused === 1 ? '1 pausada' : `${paused} pausadas`,
    },
    evaluated:
      evaluated === null
        ? { value: '—', sub: since }
        : { value: formatCount(evaluated), sub: 'avaliações por regra, hoje' },
    matches:
      activity === null
        ? { value: '—', sub: since }
        : { value: formatCount(totalMatches), sub: leader !== null ? `${leader.name} lidera` : 'nenhum ainda' },
    lastMatch: { at: last?.last_match_at ?? null, source: last?.name ?? null },
  }
}

export interface Bar {
  day: string
  value: number | null
  /** 0..1 against the busiest day of the whole table, so rows stay comparable. */
  ratio: number
}

/** Max evaluated value across every source/day, at least 1. */
export function barScale(activity: SourcesActivity | null): number {
  let max = 1
  for (const row of activity?.sources ?? []) {
    for (const day of row.daily) if (day.evaluated != null && day.evaluated > max) max = day.evaluated
  }
  return max
}

export function buildBars(row: SourceActivity | undefined, scale: number): Bar[] {
  return (row?.daily ?? []).map((day) => ({
    day: day.day,
    value: day.evaluated,
    ratio: day.evaluated === null ? 0 : Math.min(1, day.evaluated / scale),
  }))
}

export const SOURCE_HUES = 5

/** Stable hue (1..5) per source, so the avatar and the last bar share a color across reloads. */
export function sourceHue(id: number): number {
  return (Math.abs(id) % SOURCE_HUES) + 1
}

export function sourceInitial(name: string): string {
  const letter = name.trim().charAt(0)
  return letter === '' ? '?' : letter.toLocaleUpperCase('pt-BR')
}
