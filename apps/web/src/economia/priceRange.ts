import type { ReportItem } from '../api/purchases'

/**
 * S21-04: where a purchase fell inside the range of prices the teleyes saw.
 *
 * `ok` needs the three reference prices of the report (lowest, median, highest). A
 * purchase without them is `no_history`: it stays out of the saving and the bar is
 * drawn dashed. The paid marker is pinned to the edge when it is outside the range
 * (`outside`), but its colour still comes from the real comparison with the median.
 */
export type PriceRange =
  | { status: 'no_history' }
  | {
      status: 'ok'
      minCents: number
      medianCents: number
      maxCents: number
      paidCents: number
      /** 0-100, position along the bar. */
      medianPos: number
      paidPos: number
      /** Paid at or below the median (green) or above it (red). */
      tone: 'good' | 'bad'
      outside: 'low' | 'high' | null
    }

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export function priceRange(item: ReportItem): PriceRange {
  const savings = item.savings
  if (
    savings === null ||
    savings.status !== 'ok' ||
    savings.lowest_seen_cents === null ||
    savings.highest_seen_cents === null ||
    savings.median_90d_cents === null
  ) {
    return { status: 'no_history' }
  }
  const median = savings.median_90d_cents
  const min = Math.min(savings.lowest_seen_cents, median)
  const max = Math.max(savings.highest_seen_cents, median)
  const span = max - min
  const position = (cents: number) => (span <= 0 ? 50 : clampPct(((cents - min) / span) * 100))
  const paid = item.price_cents
  return {
    status: 'ok',
    minCents: min,
    medianCents: median,
    maxCents: max,
    paidCents: paid,
    medianPos: position(median),
    paidPos: position(paid),
    tone: paid > median ? 'bad' : 'good',
    outside: paid < min ? 'low' : paid > max ? 'high' : null,
  }
}
