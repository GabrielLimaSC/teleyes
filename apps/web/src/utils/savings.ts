import type { ItemReference, ItemSavings, ReportItem } from '../api/purchases'

export const METHODOLOGY =
  'Estimativa baseada só nos preços que o próprio teleyes viu no Telegram antes da compra: ' +
  'comparamos o valor pago com a mediana dos 90 dias anteriores. Não é uma garantia de preço de mercado, ' +
  'e sem histórico suficiente (menos de 3 preços) não calculamos economia.'

export function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function formatCount(value: number): string {
  return value.toLocaleString('pt-BR')
}

export function formatPct(value: number): string {
  return `${value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

/** "+R$ 350,00" for a saving, "−R$ 50,00" for paying above the median. */
export function formatSigned(cents: number): string {
  if (cents === 0) return formatCurrency(0)
  const sign = cents > 0 ? '+' : '−'
  return `${sign}${formatCurrency(Math.abs(cents))}`
}

export type SavingTone = 'good' | 'bad' | 'neutral' | 'none'

export function savingTone(savings: ItemSavings | null): SavingTone {
  if (savings === null || savings.status !== 'ok' || savings.saving_vs_median_cents === null) return 'none'
  if (savings.saving_vs_median_cents > 0) return 'good'
  if (savings.saving_vs_median_cents < 0) return 'bad'
  return 'neutral'
}

/** What the table cell says: a figure, "sem dados" (no history yet) or "—" (not linked). */
export function savingLabel(savings: ItemSavings | null): string {
  if (savings === null) return '—'
  if (savings.status !== 'ok' || savings.saving_vs_median_cents === null) return 'sem dados'
  const amount = formatSigned(savings.saving_vs_median_cents)
  return savings.saving_vs_median_pct === null ? amount : `${amount} (${formatPct(savings.saving_vs_median_pct)})`
}

export function blackFridayLabel(days: number): string {
  if (days === 0) return 'No dia da Black Friday'
  if (days > 0) return `${days} ${days === 1 ? 'dia' : 'dias'} antes`
  const after = Math.abs(days)
  return `${after} ${after === 1 ? 'dia' : 'dias'} depois`
}

/** Pill text of the Economia column: "+R$ 30,00 · 11,1%", "−R$ 30,00 · 6,5%" or "sem histórico". */
export function savingPill(savings: ItemSavings | null): string {
  if (savings === null || savings.status !== 'ok' || savings.saving_vs_median_cents === null) return 'sem histórico'
  const amount = formatSigned(savings.saving_vs_median_cents)
  if (savings.saving_vs_median_pct === null) return amount
  return `${amount} · ${formatPct(Math.abs(savings.saving_vs_median_pct))}`
}

/** "pela regra RTX 5070" / "pelo produto vinculado" / null when the purchase has no link (S22-01). */
export function historyOrigin(item: Pick<ReportItem, 'link_kind' | 'link_label'>): string | null {
  if (item.link_kind === 'rule') return item.link_label ? `pela regra ${item.link_label}` : 'pela regra vinculada'
  if (item.link_kind === 'product') return 'pelo produto vinculado'
  return null
}

/** Pill for a saving against the user's own reference; always worded as theirs. */
export function referencePill(reference: ItemReference): string {
  const amount = formatSigned(reference.saving_cents)
  return reference.pct === null ? amount : `${amount} · ${formatPct(Math.abs(reference.pct))}`
}

/** "Referência sua: R$ 529,00 (média do Google Shopping)". */
export function referenceMarkerLabel(reference: ItemReference): string {
  const note = reference.note ? ` (${reference.note})` : ''
  return `Referência sua: ${formatCurrency(reference.price_cents)}${note}`
}
