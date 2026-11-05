import type { GoalReport, Purchase, ReportItem, SavingsReport } from '../api/purchases'
import { EmptyState } from '../components/EmptyState'
import { HelpTip } from '../components/HelpTip'
import { RowActionsMenu } from '../components/RowActionsMenu'
import { parseApiDate } from '../utils/dates'
import {
  METHODOLOGY,
  formatCount,
  formatCurrency,
  formatPct,
  formatSigned,
  historyOrigin,
  referencePill,
  savingPill,
  savingTone,
} from '../utils/savings'
import { PACE_LABEL, goalBarPct, goalDay } from './GoalCard'
import { PriceRangeBar } from './PriceRangeBar'
import { ReferenceMarker } from './ReferenceMarker'
import { paidShares, purchasePeriod, savingsBars, savingsHeadline } from './summary'
import './EconomiaMobile.css'

export function dayMonth(iso: string): string {
  return parseApiDate(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

/** "+8,3%" / "−2,0%" of the goal; the sign matters (an overpayment subtracts). */
export function shareLabel(share: number): string {
  const text = formatPct(Math.abs(share))
  return share > 0 ? `+${text}` : share < 0 ? `−${text}` : text
}

interface Props {
  report: SavingsReport
  purchaseById: Map<number, Purchase>
  onEditGoal: () => void
  onEdit: (purchase: Purchase, focusLink?: boolean) => void
  onDelete: (purchase: Purchase) => void
  onCreate: () => void
}

/** S24-04c: phone layout of Economia (comp 23): savings, paid + goal, purchases, noise. */
export function EconomiaMobile({ report, purchaseById, onEditGoal, onEdit, onDelete, onCreate }: Props) {
  return (
    <>
      <SavingsHero report={report} />
      <div className="eco-m__pair">
        <PaidTile report={report} />
        <GoalTile goal={report.goal ?? null} onEdit={onEditGoal} />
      </div>
      <section className="eco-m__section" aria-label="Compras">
        <h2>Compras</h2>
        <ul className="eco-m__legend" aria-label="Legenda">
          <li>
            <span className="eco-m__lg eco-m__lg--range" aria-hidden="true" />
            faixa 90d
          </li>
          <li>
            <span className="eco-m__lg eco-m__lg--median" aria-hidden="true" />
            mediana
          </li>
          <li>
            <span className="eco-m__lg eco-m__lg--paid" aria-hidden="true" />
            você pagou
          </li>
        </ul>
        {report.items.length === 0 ? (
          <EmptyState
            title="Nenhuma compra registrada"
            text="Aqui você vê quanto pagou a menos que o preço visto pelo teleyes. Registre uma compra aqui ou use “Marcar como comprado” num card das Ofertas."
            action={{ label: 'Registrar primeira compra', onClick: onCreate }}
          />
        ) : (
          <ul className="eco-m__list">
            {report.items.map((item) => (
              <PurchaseRow
                key={item.id}
                item={item}
                purchase={purchaseById.get(item.id)}
                hasGoal={report.goal != null}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </section>
      <Noise report={report} />
    </>
  )
}

function SavingsHero({ report }: { report: SavingsReport }) {
  const { totals } = report
  const hasData = totals.linked_with_data > 0
  const { badge, tone } = savingsHeadline(report)
  const bars = savingsBars(report.items)
  const withoutHistory = totals.purchases - totals.linked_with_data
  return (
    <section className="plane-pearl eco-m__hero" aria-label="Economia estimada">
      <div className="eco-m__label help-inline">
        Economia estimada
        <HelpTip term="Economia estimada">
          Quanto você pagou a menos que o preço típico que o teleyes viu antes. É uma estimativa, não um valor exato.
        </HelpTip>
      </div>
      <div className={`eco-m__big economia-tone--${tone}`}>
        {hasData ? formatSigned(totals.estimated_saving_cents) : 'sem dados'}
      </div>
      {badge && <div className={`eco-m__badge economia-tone--${tone}`}>{badge}</div>}
      {bars && (
        <dl className="eco-m__pairs">
          <div>
            <dt>Mediana 90d</dt>
            <dd>{formatCurrency(bars.medianCents)}</dd>
          </div>
          <div>
            <dt>Você pagou</dt>
            <dd>{formatCurrency(bars.paidCents)}</dd>
          </div>
        </dl>
      )}
      {(totals.reference_purchases ?? 0) > 0 && (
        <p className="eco-m__ref" data-testid="reference-saving">
          {formatSigned(totals.reference_saving_cents ?? 0)} pelas suas referências ({totals.reference_purchases}{' '}
          {totals.reference_purchases === 1 ? 'compra' : 'compras'}), valores que você informou, fora da estimativa do
          teleyes
        </p>
      )}
      <details className="eco-m__how">
        <summary>Como calculamos</summary>
        <p>
          {hasData
            ? `${totals.linked_with_data} de ${totals.purchases} ${totals.purchases === 1 ? 'compra' : 'compras'} com histórico${withoutHistory > 0 ? ` (${withoutHistory} sem histórico, fora da conta)` : ''}. `
            : 'Nenhuma compra tem histórico suficiente para estimar. '}
          {METHODOLOGY}
        </p>
      </details>
    </section>
  )
}

function PaidTile({ report }: { report: SavingsReport }) {
  const { totals } = report
  const period = purchasePeriod(report.items)
  const top = paidShares(report.items)[0]
  return (
    <section className="plane-pearl eco-m__tile" aria-label="Total pago">
      <div className="eco-m__label">Total pago</div>
      <div className="eco-m__value">{formatCurrency(totals.total_paid_cents)}</div>
      <div className="eco-m__sub">
        {totals.purchases} {totals.purchases === 1 ? 'compra' : 'compras'}
        {period ? ` · ${period}` : ''}
      </div>
      {top && report.items.length > 1 && <div className="eco-m__sub">{Math.round(top.share)}% numa única peça</div>}
    </section>
  )
}

function GoalTile({ goal, onEdit }: { goal: GoalReport | null; onEdit: () => void }) {
  if (!goal) {
    return (
      <section className="plane-pearl eco-m__tile" aria-label="Meta de economia">
        <div className="eco-m__label">Meta</div>
        <div className="eco-m__sub">Defina quanto quer economizar e até quando.</div>
        <button type="button" className="eco-m__link" onClick={onEdit}>
          Definir meta
        </button>
      </section>
    )
  }
  const shown = Math.round(goalBarPct(goal))
  return (
    <section className="plane-pearl eco-m__tile" aria-label="Meta de economia">
      <div className="eco-m__tilehead">
        <div className="eco-m__label">Meta</div>
        <button type="button" className="eco-m__link" onClick={onEdit}>
          editar
        </button>
      </div>
      <div className="eco-m__value">{shown}%</div>
      <div
        className="economia-goal__track"
        role="progressbar"
        aria-label="Progresso da meta de economia"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown}
      >
        <span className="economia-goal__fill" style={{ width: `${goalBarPct(goal)}%` }} />
      </div>
      <div className="eco-m__sub">
        de {formatCurrency(goal.amount_cents)} · até {goalDay(goal.deadline)}
      </div>
      <div className="eco-m__sub">
        <span className={`economia-goal__pace economia-goal__pace--${goal.pace}`}>ritmo: {PACE_LABEL[goal.pace]}</span>
      </div>
    </section>
  )
}

function PurchaseRow({
  item,
  purchase,
  hasGoal,
  onEdit,
  onDelete,
}: {
  item: ReportItem
  purchase: Purchase | undefined
  hasGoal: boolean
  onEdit: (purchase: Purchase, focusLink?: boolean) => void
  onDelete: (purchase: Purchase) => void
}) {
  const tone = savingTone(item.savings)
  const pill = savingPill(item.savings)
  const origin = historyOrigin(item)
  const reference = item.reference ?? null
  const noHistory = pill === 'sem histórico'
  return (
    <li className="plane-pearl eco-m__item">
      <div className="eco-m__itemhead">
        <div className="eco-m__itemname">
          <strong>{item.name}</strong>
          <span>{[item.store, dayMonth(item.purchased_at), origin].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="eco-m__paid">{formatCurrency(item.price_cents)}</div>
        {purchase && (
          <RowActionsMenu
            label={`Mais ações da compra ${item.name}`}
            items={[
              { key: 'edit', label: 'Editar', onSelect: () => onEdit(purchase) },
              { key: 'delete', label: 'Excluir', danger: true, onSelect: () => onDelete(purchase) },
            ]}
          />
        )}
      </div>
      <div className="eco-m__range">{reference ? <ReferenceMarker item={item} /> : <PriceRangeBar item={item} />}</div>
      <div className="eco-m__foot">
        {reference ? (
          <span className="economia-pill economia-pill--reference">
            {referencePill(reference)}
            <span className="economia-pill__tag">pela sua referência</span>
          </span>
        ) : noHistory && purchase ? (
          <span className="eco-m__actions">
            {item.link_kind == null && (
              <button type="button" className="economia-pill economia-pill--action" onClick={() => onEdit(purchase, true)}>
                Vincular regra
              </button>
            )}
            <button type="button" className="economia-pill economia-pill--action" onClick={() => onEdit(purchase)}>
              Referência sua
            </button>
          </span>
        ) : (
          <span className={`economia-pill economia-pill--${tone}`}>{pill}</span>
        )}
        {hasGoal && (
          <span className="eco-m__share">meta {item.share_of_goal == null ? '—' : shareLabel(item.share_of_goal)}</span>
        )}
      </div>
    </li>
  )
}

function Noise({ report }: { report: SavingsReport }) {
  const { noise } = report
  const discarded = noise.discarded.sem_termo + noise.discarded.bloqueado + noise.discarded.preco_acima_teto
  return (
    <section className="plane-pearl eco-m__noise" aria-label="Ruído evitado">
      <h2>Ruído evitado</h2>
      <p className="eco-m__sub">Só contadores; o teleyes nunca guarda o texto do que descartou.</p>
      <dl className="eco-m__noisegrid">
        <div>
          <dt>Mensagens analisadas</dt>
          <dd>{formatCount(noise.messages_analyzed)}</dd>
        </div>
        <div>
          <dt>Descartadas</dt>
          <dd>{formatCount(discarded)}</dd>
          <dd className="eco-m__sub">
            {formatCount(noise.discarded.sem_termo)} sem termo · {formatCount(noise.discarded.bloqueado)} bloqueadas ·{' '}
            {formatCount(noise.discarded.preco_acima_teto)} acima do preço máximo
          </dd>
        </div>
        <div>
          <dt>Repetidos agrupados</dt>
          <dd>{formatCount(noise.duplicates_grouped)}</dd>
        </div>
        <div>
          <dt>Alertas enviados</dt>
          <dd>{formatCount(noise.alerts_sent)}</dd>
          <dd className="eco-m__sub">de {formatCount(noise.alerts_matched)} ofertas</dd>
        </div>
      </dl>
    </section>
  )
}
