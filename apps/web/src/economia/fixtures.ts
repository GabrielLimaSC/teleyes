import type { ItemSavings, ReportItem, SavingsReport } from '../api/purchases'

/** Test fixtures for the Economia screen (fictional data only). */

export const savingsOk = (overrides: Partial<ItemSavings> = {}): ItemSavings => ({
  status: 'ok',
  samples_90d: 6,
  samples_30d: 3,
  median_30d_cents: 150_000,
  average_30d_cents: 151_000,
  median_90d_cents: 155_000,
  average_90d_cents: 156_000,
  lowest_seen_cents: 140_000,
  highest_seen_cents: 170_000,
  usual_price_cents: 154_000,
  saving_vs_median_cents: 35_000,
  saving_vs_median_pct: 22.6,
  saving_vs_usual_cents: 34_000,
  saving_vs_usual_pct: 22.1,
  ...overrides,
})

export const savingsNoData = (): ItemSavings => ({
  status: 'no_data',
  samples_90d: 1,
  samples_30d: 1,
  median_30d_cents: null,
  average_30d_cents: null,
  median_90d_cents: null,
  average_90d_cents: null,
  lowest_seen_cents: 99_000,
  highest_seen_cents: 99_000,
  usual_price_cents: null,
  saving_vs_median_cents: null,
  saving_vs_median_pct: null,
  saving_vs_usual_cents: null,
  saving_vs_usual_pct: null,
})

export const reportItem = (overrides: Partial<ReportItem> = {}): ReportItem => ({
  id: 1,
  name: 'Placa-mãe B850M',
  store: 'Loja Exemplo',
  price_cents: 120_000,
  purchased_at: '2026-10-20T15:00:00Z',
  linked: true,
  days_before_black_friday: 38,
  savings: savingsOk(),
  ...overrides,
})

export const savingsReport = (overrides: Partial<SavingsReport> = {}): SavingsReport => ({
  generated_at: '2026-10-26T12:00:00Z',
  totals: {
    purchases: 3,
    linked_with_data: 2,
    total_paid_cents: 300_000,
    estimated_saving_cents: 25_000,
    reference_total_cents: 325_000,
    estimated_saving_pct: 7.7,
  },
  black_friday: {
    date: '2026-11-27',
    is_default: true,
    purchases_before: 3,
    days_before_min: 38,
    days_before_max: 52,
  },
  items: [
    reportItem(),
    reportItem({
      id: 2,
      name: 'SSD NVMe 2 TB',
      store: null,
      price_cents: 60_000,
      days_before_black_friday: 45,
      savings: savingsOk({ saving_vs_median_cents: -10_000, saving_vs_median_pct: -20, median_90d_cents: 50_000 }),
    }),
    reportItem({
      id: 3,
      name: 'Cabo HDMI',
      store: null,
      price_cents: 4_990,
      linked: false,
      days_before_black_friday: 52,
      savings: null,
    }),
  ],
  noise: {
    period_start: '2026-07-01T00:00:00Z',
    period_end: '2026-10-26T12:00:00Z',
    counters_scope: 'all_time',
    messages_analyzed: 20_298,
    discarded: { sem_termo: 19_561, bloqueado: 429, preco_acima_teto: 132 },
    alerts_matched: 176,
    duplicates_grouped: 36,
    alerts_sent: 269,
  },
  ...overrides,
})

export const TEST_PALETTE = {
  background: 'var(--bg)',
  glow: 'var(--glow)',
  surface: 'var(--surface)',
  border: 'var(--border)',
  text: 'var(--text)',
  muted: 'var(--muted)',
  good: 'var(--good)',
  bad: 'var(--bad)',
  accent: 'var(--accent)',
}
