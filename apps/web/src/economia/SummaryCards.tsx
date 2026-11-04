import { HelpTip } from '../components/HelpTip'
import type { SavingsReport } from '../api/purchases'
import {
  METHODOLOGY,
  formatCurrency,
  formatSigned,
} from '../utils/savings'
import { paidShares, purchasePeriod, savingsBars, savingsHeadline } from './summary'

const SEGMENT_COLORS = ['primary', 'alt', 'good', 'warn'] as const

/** Hero card: estimated saving, honest in both directions (S21-04). */
export function SavingsCard({ report }: { report: SavingsReport }) {
  const { totals } = report
  const hasData = totals.linked_with_data > 0
  const { badge, tone } = savingsHeadline(report)
  const bars = savingsBars(report.items)
  const withoutHistory = totals.purchases - totals.linked_with_data
  return (
    <div className="plane-pearl economia-tile economia-tile--hero">
      <div className="economia-tile__label help-inline">
        Economia estimada
        <HelpTip term="Economia estimada">
          Quanto você pagou a menos que o preço típico que o teleyes viu antes. É uma estimativa, não um valor exato.
        </HelpTip>
      </div>
      <div className="economia-hero__line">
        <div className={`economia-tile__value economia-tile__value--hero economia-tone--${tone}`}>
          {hasData ? formatSigned(totals.estimated_saving_cents) : 'sem dados'}
        </div>
        {badge && <span className={`economia-badge economia-badge--${tone}`}>{badge}</span>}
      </div>
      {bars && (
        <div className="economia-bars" aria-label="Mediana contra o valor pago, só das compras com histórico">
          <div className="economia-bars__row">
            <span className="help-inline">
              Mediana 90d
              <HelpTip term="Mediana 90d">
                O preço do meio entre todos os que o produto teve nos últimos 90 dias. Serve de referência do que é
                normal.
              </HelpTip>
            </span>
            <span className="economia-bars__track">
              <span className="economia-bars__fill economia-bars__fill--median" style={{ width: `${bars.medianWidth}%` }} />
            </span>
            <span className="economia-bars__value">{formatCurrency(bars.medianCents)}</span>
          </div>
          <div className="economia-bars__row">
            <span>Você pagou</span>
            <span className="economia-bars__track">
              <span
                className={`economia-bars__fill economia-bars__fill--${tone === 'bad' ? 'bad' : 'good'}`}
                style={{ width: `${bars.paidWidth}%` }}
              />
            </span>
            <span className="economia-bars__value">{formatCurrency(bars.paidCents)}</span>
          </div>
        </div>
      )}
      {(totals.reference_purchases ?? 0) > 0 && (
        <p className="economia-hero__reference" data-testid="reference-saving">
          {formatSigned(totals.reference_saving_cents ?? 0)} pelas suas referências ({totals.reference_purchases}{' '}
          {totals.reference_purchases === 1 ? 'compra' : 'compras'}), valores que você informou, fora da estimativa
          do teleyes
        </p>
      )}
      <p className="economia-tile__detail economia-hero__method">
        {hasData
          ? `${totals.linked_with_data} de ${totals.purchases} ${totals.purchases === 1 ? 'compra' : 'compras'} com histórico${withoutHistory > 0 ? ` (${withoutHistory} sem histórico, fora da conta)` : ''}. `
          : 'Nenhuma compra tem histórico suficiente para estimar. '}
        {METHODOLOGY}
      </p>
    </div>
  )
}

export function PaidCard({ report }: { report: SavingsReport }) {
  const { totals } = report
  const shares = paidShares(report.items)
  const top = shares[0]
  const period = purchasePeriod(report.items)
  return (
    <div className="plane-pearl economia-tile">
      <div className="economia-tile__label">Total pago</div>
      <div className="economia-tile__value">{formatCurrency(totals.total_paid_cents)}</div>
      <div className="economia-tile__detail">
        {totals.purchases} {totals.purchases === 1 ? 'compra' : 'compras'}
        {period ? ` · ${period}` : ''}
      </div>
      {top && (
        <div className="economia-split">
          <div className="economia-split__bar" role="img" aria-label="Participação de cada compra no total pago">
            {shares.map((share, index) => (
              <span
                key={share.id}
                className={`economia-split__seg economia-split__seg--${SEGMENT_COLORS[index % SEGMENT_COLORS.length]}`}
                style={{ flexGrow: share.share }}
              />
            ))}
          </div>
          {shares.length > 1 && (
            <div className="economia-tile__detail">
              {Math.round(top.share)}% numa única peça ({top.name})
            </div>
          )}
        </div>
      )}
    </div>
  )
}
