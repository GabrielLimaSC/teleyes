import type { ReportItem } from '../api/purchases'
import { formatCurrency } from '../utils/savings'
import { priceRange } from './priceRange'

/** The "where the price fell" bar of one purchase (S21-04). */
export function PriceRangeBar({ item }: { item: ReportItem }) {
  const range = priceRange(item)
  if (range.status === 'no_history') {
    return (
      <div className="price-range price-range--empty" data-testid="price-range">
        <div className="price-range__track price-range__track--dashed" />
        <div className="price-range__note">menos de 3 preços vistos — fora da conta</div>
      </div>
    )
  }
  const outsideNote =
    range.outside === 'low' ? 'abaixo da faixa vista' : range.outside === 'high' ? 'acima da faixa vista' : null
  return (
    <div className="price-range" data-testid="price-range">
      <div className="price-range__track">
        <span className="price-range__median" style={{ left: `${range.medianPos}%` }} aria-hidden="true" />
        <span
          className={`price-range__paid price-range__paid--${range.tone}`}
          style={{ left: `${range.paidPos}%` }}
          data-outside={range.outside ?? undefined}
          role="img"
          aria-label={`Você pagou ${formatCurrency(range.paidCents)}${outsideNote ? `, ${outsideNote}` : ''}`}
        />
      </div>
      <div className="price-range__labels">
        <span>{formatCurrency(range.minCents)}</span>
        <span>mediana {formatCurrency(range.medianCents)}</span>
        <span>{formatCurrency(range.maxCents)}</span>
      </div>
    </div>
  )
}
