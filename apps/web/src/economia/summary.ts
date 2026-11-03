import type { ReportItem, SavingsReport } from '../api/purchases'
import { parseApiDate } from '../utils/dates'

/** Derived numbers for the top cards (S21-04). Only purchases with history count. */
export interface SavingsBars {
  /** Sum of the 90-day medians of the purchases with history. */
  medianCents: number
  /** What was paid for those same purchases. */
  paidCents: number
  /** Bar widths, 0-100; the larger of the two is 100. */
  medianWidth: number
  paidWidth: number
}

export function savingsBars(items: ReportItem[]): SavingsBars | null {
  let median = 0
  let paid = 0
  let counted = 0
  for (const item of items) {
    const savings = item.savings
    if (savings === null || savings.status !== 'ok' || savings.median_90d_cents === null) continue
    median += savings.median_90d_cents
    paid += item.price_cents
    counted += 1
  }
  if (counted === 0) return null
  const widest = Math.max(median, paid, 1)
  return { medianCents: median, paidCents: paid, medianWidth: (median / widest) * 100, paidWidth: (paid / widest) * 100 }
}

export interface PaidShare {
  id: number
  name: string
  share: number
}

/** Share of the total paid per purchase, largest first. */
export function paidShares(items: ReportItem[]): PaidShare[] {
  const total = items.reduce((sum, item) => sum + item.price_cents, 0)
  if (total <= 0) return []
  return items
    .map((item) => ({ id: item.id, name: item.name, share: (item.price_cents / total) * 100 }))
    .sort((a, b) => b.share - a.share)
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')
}

/** "out 2026", "set–out 2026" or "dez 2025–jan 2026". */
export function purchasePeriod(items: ReportItem[]): string | null {
  if (items.length === 0) return null
  const times = items.map((item) => parseApiDate(item.purchased_at))
  const first = new Date(Math.min(...times.map((date) => date.getTime())))
  const last = new Date(Math.max(...times.map((date) => date.getTime())))
  if (first.getFullYear() !== last.getFullYear()) {
    return `${monthLabel(first)} ${first.getFullYear()}–${monthLabel(last)} ${last.getFullYear()}`
  }
  if (first.getMonth() === last.getMonth()) return `${monthLabel(first)} ${first.getFullYear()}`
  return `${monthLabel(first)}–${monthLabel(last)} ${first.getFullYear()}`
}

export function savingsHeadline(report: SavingsReport): { badge: string | null; tone: 'good' | 'bad' | 'none' } {
  const { totals } = report
  if (totals.linked_with_data === 0) return { badge: null, tone: 'none' }
  const tone = totals.estimated_saving_cents < 0 ? 'bad' : 'good'
  if (totals.estimated_saving_pct === null) return { badge: null, tone }
  const pct = Math.abs(totals.estimated_saving_pct).toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
  if (totals.estimated_saving_cents === 0) return { badge: 'na mediana', tone }
  return { badge: `${pct}% ${tone === 'bad' ? 'acima' : 'abaixo'} da mediana`, tone }
}
