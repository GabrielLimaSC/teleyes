import type { ItemSavings } from '../api/purchases'

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
