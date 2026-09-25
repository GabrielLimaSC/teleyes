import { useState } from 'react'
import type { FormEvent } from 'react'
import { CategoryIcon } from './CategoryIcon'
import { categorize, CATEGORY_BACKGROUND, CATEGORY_ICON_COLOR } from './matchCategory'
import { summarizeDeliveryStatus } from './deliveryStatus'
import { Tooltip } from './Tooltip'
import { cardTitle, productText } from './matchTitle'
import { PRODUCT_OPEN_CONTROL_ATTR } from './ProductPanel'
import type { Match, Recipient, Rule, Source } from '../api/types'
import { formatMatchedAt } from '../utils/dates'
import './MatchCard.css'
import '../components/GlassCard.css'
import '../components/AuroraGlow.css'
import '../styles/productOpenTrigger.css'
import '../styles/materials.css'

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatPrice(cents: number | null): string {
  if (cents === null) return 'Preço não identificado'
  return formatCurrency(cents)
}

// S14-07 (06): a small 90-day sparkline with the target price as a dashed
// line — every card gets one whenever `match.sparkline` has real points, the
// hero-only distinction from the comp's mockup is not carried over (the
// same MatchCard renders every position in the 06 grid, see 06b).
const SPARK_WIDTH = 108
const SPARK_HEIGHT = 34
const SPARK_PAD_Y = 4

interface SparkGeometry {
  points: string
  lastX: number
  lastY: number
  targetY: number | null
}

function buildSparkGeometry(
  series: Match['sparkline'] | undefined,
  targetCents: number | null,
): SparkGeometry | null {
  if (series === undefined || series.length === 0) return null
  const prices = series.map((point) => point.price_cents)
  const values = targetCents !== null ? [...prices, targetCents] : prices
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min

  const toY = (value: number) =>
    span === 0 ? SPARK_HEIGHT / 2 : SPARK_PAD_Y + (1 - (value - min) / span) * (SPARK_HEIGHT - SPARK_PAD_Y * 2)

  const coords = series.map((point, index) => {
    const x = series.length === 1 ? SPARK_WIDTH / 2 : (index / (series.length - 1)) * SPARK_WIDTH
    return { x, y: toY(point.price_cents) }
  })
  const last = coords[coords.length - 1]

  return {
    points: coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
    lastX: last.x,
    lastY: last.y,
    targetY: targetCents !== null ? toY(targetCents) : null,
  }
}

function MatchSparkline({ match }: { match: Match }) {
  const geometry = buildSparkGeometry(match.sparkline, match.target_price_cents)
  if (geometry === null) return null

  return (
    <div className="match-card__spark">
      <svg
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        width={SPARK_WIDTH}
        height={SPARK_HEIGHT}
        preserveAspectRatio="none"
        role="img"
        aria-label="Histórico de preço, 90 dias"
        className="match-card__spark-chart"
      >
        {geometry.targetY !== null && (
          <line
            x1="0"
            y1={geometry.targetY}
            x2={SPARK_WIDTH}
            y2={geometry.targetY}
            className="match-card__spark-target-line"
          />
        )}
        <polyline points={geometry.points} className="match-card__spark-line" />
        <circle
          cx={geometry.lastX}
          cy={geometry.lastY}
          r="3.5"
          className={'match-card__spark-dot' + (match.target_hit ? ' match-card__spark-dot--hit' : '')}
        />
      </svg>
      <div className="match-card__spark-axis">
        <span>90 dias</span>
        {geometry.targetY !== null && <span>linha = alvo</span>}
      </div>
    </div>
  )
}

export function MatchCard({
  match,
  rule,
  source,
  recipients,
  isLowestPriceEver = false,
  groupedSourceNames,
  onOpenProduct,
  onCreateRule,
  onSnooze,
  onSetTarget,
}: {
  match: Match
  rule: Rule | undefined
  source: Source | undefined
  recipients: Recipient[]
  /** Aurora Glow ring (docs/SPRINT4_DIRECTION.md). S7-06: driven by
   * `Match.is_lowest_price_ever`, computed on the backend on every read from
   * the rule's real match history — never a value stored on the match
   * itself. Defaults to `false` for callers (tests, mostly) that don't pass
   * it. */
  isLowestPriceEver?: boolean
  /** S7-11: names resolved by the caller from `match.grouped_source_ids`
   * (this component never resolves ids itself — same pattern as `source`).
   * Undefined/empty renders nothing. */
  groupedSourceNames?: string[]
  /** S14-08 (07b): the "Abrir produto ›" trigger and the clickable title —
   * both call this with `match.product_key` and the exact element clicked
   * (07b's focus-return target). Only rendered when the match actually has
   * a `product_key`; the card itself is never clickable as a whole.
   * S14-07: also what "Corrigir" opens — the panel is the only correction UI
   * this delivery has (tela 08/S14-08 parte 2 is a separate task). */
  onOpenProduct?: (productKey: string, trigger: HTMLElement) => void
  /** S14-07: "Criar regra disso" — the page navigates to
   * `/regras?produto=<key>` (Regras v2's own contract); only rendered with a
   * `product_key`. */
  onCreateRule?: (productKey: string) => void
  /** S14-07: "Silenciar 7 dias" / "Reativar" (toggled by `match.snoozed`) —
   * the page owns the actual `POST`/`DELETE /snoozes` (scope `'product'`);
   * only rendered with a `product_key`. */
  onSnooze?: (match: Match) => void
  /** S14-07: "Definir alvo" — cents already parsed from the inline field;
   * the page owns the actual `PATCH /rules/{id}`. */
  onSetTarget?: (ruleId: number, targetCents: number) => void
}) {
  const [showTargetForm, setShowTargetForm] = useState(false)
  const [targetInput, setTargetInput] = useState(
    match.target_price_cents !== null ? String(match.target_price_cents / 100) : '',
  )

  const category = categorize(match.message_text)
  const status = summarizeDeliveryStatus(match.deliveries)
  const recipientNames = match.deliveries
    .map((delivery) => recipients.find((recipient) => recipient.id === delivery.recipient_id)?.name)
    .filter((name): name is string => Boolean(name))

  // S9-02: the S9-06 cut never deletes information, only hides it from the
  // card's face — surface it back on hover/focus instead of leaving no way
  // to recover it. `linkCutText` is the pre-cut baseline (S8-02's own cut,
  // never the raw `message_text` with its link/footer): comparing against
  // it, not the final title, is what tells `wasTruncated` apart from the
  // S8-02 cut it's already fine to leave unexplained.
  const linkCutText = productText(match.message_text)
  const title = cardTitle(match.message_text, rule)
  const wasTruncated = title !== linkCutText
  const productKey = match.product_key
  const canOpenProduct = productKey !== null && onOpenProduct !== undefined

  function openProduct(trigger: HTMLElement) {
    if (productKey !== null && onOpenProduct) onOpenProduct(productKey, trigger)
  }

  const productTitle = canOpenProduct ? (
    <button
      type="button"
      className="match-card__product match-card__product--button"
      {...{ [PRODUCT_OPEN_CONTROL_ATTR]: true }}
      onClick={(event) => openProduct(event.currentTarget)}
    >
      {title}
    </button>
  ) : (
    <p className="match-card__product">{title}</p>
  )

  // S14-05 (F5) — "Visto em N fontes" pill, a different mechanism from the
  // S7-11 "Visto em: <names>" line below (same rule/price chained over time
  // vs. same product/price across sources): both can render at once.
  const seenCount = match.seen_count ?? 1
  const showSeenBadge = seenCount > 1
  // S14-06 (F7) manual-edit fields.
  const priceUnidentified = match.price_cents === null
  const manuallyEdited = match.price_source === 'manual'

  const hasCashCard = match.price_cash_cents !== null && match.price_card_cents !== null
  const showTargetGapLine =
    !hasCashCard && !match.target_hit && match.target_price_cents !== null && match.target_gap_pct !== null

  const canCreateRule = productKey !== null && onCreateRule !== undefined
  const canSnooze = productKey !== null && onSnooze !== undefined
  const canSetTarget = onSetTarget !== undefined
  const canCorrect = productKey !== null && priceUnidentified && onOpenProduct !== undefined

  function submitTarget(event: FormEvent) {
    event.preventDefault()
    const cents = Math.round(Number(targetInput) * 100)
    if (!Number.isFinite(cents) || cents <= 0 || onSetTarget === undefined) return
    onSetTarget?.(match.rule_id, cents)
    setShowTargetForm(false)
  }

  return (
    <article className={'glass-card match-card' + (isLowestPriceEver ? ' match-card--aurora' : '')}>
      <div className="match-card__icon" style={{ background: CATEGORY_BACKGROUND[category], color: CATEGORY_ICON_COLOR[category] }}>
        <CategoryIcon category={category} />
      </div>
      <div className="match-card__body">
        <div className="match-card__badges">
          {match.target_hit && (
            <span className="match-card__badge match-card__badge--good">Alvo atingido</span>
          )}
          {showSeenBadge && (
            <span className="match-card__badge match-card__badge--neutral">Visto em {seenCount} fontes</span>
          )}
          {priceUnidentified && (
            <span className="match-card__badge match-card__badge--warn">
              <span className="match-card__badge-dot" aria-hidden="true" />
              preço não identificado
            </span>
          )}
          {manuallyEdited && (
            <span className="match-card__badge match-card__badge--manual">
              <span className="match-card__badge-dot" aria-hidden="true" />
              editado manualmente
            </span>
          )}
          <span
            className="match-card__status"
            style={{ background: status.background, color: status.foreground }}
          >
            <span className="match-card__status-dot" style={{ background: status.dotColor }} />
            {status.label}
          </span>
        </div>
        {wasTruncated ? <Tooltip label={linkCutText}>{productTitle}</Tooltip> : productTitle}
        <p className="match-card__meta">
          Fonte: {source?.name ?? `#${match.source_id}`} · Regra: {rule?.name ?? `#${match.rule_id}`}
          {recipientNames.length > 0 && <> · Para: {recipientNames.join(', ')}</>}
        </p>
        {groupedSourceNames !== undefined && groupedSourceNames.length > 0 && (
          <p className="match-card__grouped-sources">Visto em: {groupedSourceNames.join(', ')}</p>
        )}

        {/* S14-07 (06b): price + sparkline share one row; `margin-top: auto`
            (MatchCard.css) pushes this row — and the actions row right after
            it — to the card's base, the same anchor for every card in a grid
            row regardless of how many badge/title lines sit above it. */}
        <div className="match-card__price-row">
          <div className="match-card__price-block">
            {match.price_cash_cents !== null && match.price_card_cents !== null ? (
              <p className="match-card__price">
                {formatCurrency(match.price_cash_cents)}
                <span className="match-card__price-sub">
                  À vista · Cartão {formatCurrency(match.price_card_cents)}
                </span>
              </p>
            ) : (
              <p className="match-card__price">{formatPrice(match.price_cents)}</p>
            )}
            {showTargetGapLine && (
              <span className="match-card__price-sub">
                falta {match.target_gap_pct}% para o alvo {formatCurrency(match.target_price_cents as number)}
              </span>
            )}
            {isLowestPriceEver && <span className="match-card__aurora-label">Menor preço já visto</span>}
          </div>
          <MatchSparkline match={match} />
        </div>

        {/* S14-07 (06b): its own border-top/padding-top, so the divider also
            aligns between cards in the same grid row. */}
        <div className="match-card__actions">
          {canOpenProduct && (
            <button
              type="button"
              className={'product-open-trigger' + (isLowestPriceEver ? ' product-open-trigger--featured' : '')}
              {...{ [PRODUCT_OPEN_CONTROL_ATTR]: true }}
              onClick={(event) => openProduct(event.currentTarget)}
            >
              Abrir produto <span aria-hidden="true">›</span>
            </button>
          )}
          {canCreateRule && (
            <button
              type="button"
              className="plane-action plane-action--secondary plane-action--compact match-card__action"
              onClick={() => onCreateRule?.(productKey as string)}
            >
              Criar regra disso
            </button>
          )}
          {canSnooze && (
            <button
              type="button"
              className="plane-action plane-action--secondary plane-action--compact match-card__action"
              onClick={() => onSnooze?.(match)}
            >
              {match.snoozed ? 'Reativar' : 'Silenciar 7 dias'}
            </button>
          )}
          {canSetTarget && (
            <button
              type="button"
              className="plane-action plane-action--secondary plane-action--compact match-card__action"
              aria-expanded={showTargetForm}
              onClick={() => setShowTargetForm((current) => !current)}
            >
              Definir alvo
            </button>
          )}
          {canCorrect && (
            <button
              type="button"
              className="plane-action plane-action--secondary plane-action--compact match-card__action"
              {...{ [PRODUCT_OPEN_CONTROL_ATTR]: true }}
              onClick={(event) => openProduct(event.currentTarget)}
            >
              Corrigir
            </button>
          )}
          <span className="match-card__timestamp">{formatMatchedAt(match.matched_at)}</span>
          {match.message_link !== null && (
            <a
              className="match-card__link"
              href={match.message_link}
              target="_blank"
              rel="noopener noreferrer"
            >
              Abrir promoção
            </a>
          )}
        </div>

        {showTargetForm && canSetTarget && (
          <form className="match-card__target-form" onSubmit={submitTarget}>
            <label className="match-card__target-label">
              Alvo (R$)
              <input
                type="number"
                min="0.01"
                step="0.01"
                autoFocus
                value={targetInput}
                onChange={(event) => setTargetInput(event.target.value)}
              />
            </label>
            <button type="submit" className="plane-action plane-action--compact match-card__action">
              Salvar
            </button>
            <button
              type="button"
              className="plane-action plane-action--secondary plane-action--compact match-card__action"
              onClick={() => setShowTargetForm(false)}
            >
              Cancelar
            </button>
          </form>
        )}
      </div>
    </article>
  )
}
