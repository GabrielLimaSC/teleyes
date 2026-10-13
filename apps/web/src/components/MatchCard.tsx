import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CategoryIcon } from './CategoryIcon'
import { categorize, CATEGORY_BACKGROUND, CATEGORY_ICON_COLOR } from './matchCategory'
import { summarizeDeliveryStatus } from './deliveryStatus'
import { Tooltip } from './Tooltip'
import { cardTitle, productText } from './matchTitle'
import { PRODUCT_OPEN_CONTROL_ATTR } from './ProductPanel'
import type { Match, Recipient, Rule, Source } from '../api/types'
import { formatMatchedAt, isWithinLastDays } from '../utils/dates'
import { parsePriceInput } from '../utils/priceInput'
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

// S16-03 (06): below the price, "falta N% para o alvo" when the rule has a
// target; without one, show how today's price compares to the product's own
// recent history instead — "−6% vs. média 30d" (cheaper, good) / "+3% vs.
// média 30d" (pricier, neutral). Computed purely from `match.sparkline`
// (never a second, server-trusted number) and gated on at least 3 points in
// the window so a couple of stray days never produce a misleading percent.
// `now` is a parameter, not a fresh `Date()` inside, so this stays
// deterministic in tests — callers default it to the real clock.
export interface AverageDelta30d {
  pct: number
  belowAverage: boolean
}

const AVERAGE_WINDOW_DAYS = 30
const MIN_AVERAGE_WINDOW_POINTS = 3

export function computeAverageDelta30d(
  sparkline: Match['sparkline'],
  currentPriceCents: number | null,
  now: Date = new Date(),
): AverageDelta30d | null {
  if (currentPriceCents === null || sparkline.length === 0) return null

  const recentPrices = sparkline
    .filter((point) => isWithinLastDays(point.date, AVERAGE_WINDOW_DAYS, now))
    .map((point) => point.price_cents)
  if (recentPrices.length < MIN_AVERAGE_WINDOW_POINTS) return null

  const average = recentPrices.reduce((sum, price) => sum + price, 0) / recentPrices.length
  if (average <= 0) return null

  const pct = Math.round(((currentPriceCents - average) / average) * 100)
  return { pct, belowAverage: currentPriceCents < average }
}

// S16-03 (05): the comp's actions-row breakpoint — "Abrir produto" + "Definir
// alvo" always, everything else (Silenciar, the "Abrir promoção" label,
// which items sit in the ⋯ menu) switches below this width. Measured off the
// card's own rendered width (ResizeObserver), same pattern FeedPage.tsx's
// `gridIsWide` already uses — robust regardless of whether an ancestor
// declares `container-type` (the Feed's `.feed-page__card` does; a future
// caller that doesn't still gets the real number). Falls back to `false`
// (the wide layout) wherever ResizeObserver doesn't exist — jsdom in unit
// tests, chiefly — so the existing, un-narrowed test suite keeps working.
const NARROW_ACTIONS_BREAKPOINT = 480

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
  const [targetError, setTargetError] = useState<string | null>(null)
  const targetErrorId = useId()

  // S16-03 (05): real width of this card, not the viewport — see
  // NARROW_ACTIONS_BREAKPOINT above for why this is JS, not a `@container`
  // override like the sparkline's own 420px cutoff below.
  const cardRef = useRef<HTMLElement>(null)
  const [isNarrow, setIsNarrow] = useState(false)

  useEffect(() => {
    const element = cardRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      // S16-03 fix: `contentRect.width` excludes this card's own 16/18px
      // padding and border, under-reporting by ~38px against the card's
      // real rendered width (what a `@container` query, or anyone eyeing
      // the card, would call its width) — border-box avoids that gap.
      // `borderBoxSize` is an array (fragments, multi-column); one box here.
      const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width
      setIsNarrow(width < NARROW_ACTIONS_BREAKPOINT)
    })
    observer.observe(element, { box: 'border-box' })
    return () => observer.disconnect()
  }, [])

  // S16-03 (05): the "⋯" menu — "Criar regra disso" always, plus "Silenciar
  // 7 dias"/"Reativar" once the card is narrow enough to have pulled it off
  // the actions row. Esc, a click outside, or picking an item all close it
  // and return focus to the trigger ("foco volta ao botão").
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuPopupRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!menuOpen) return

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (menuPopupRef.current?.contains(target)) return
      if (menuButtonRef.current?.contains(target)) return
      setMenuOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      menuButtonRef.current?.focus()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    // First item, same expectation as any native menu opened by keyboard or
    // click — the popup's own buttons are reachable without landing back on
    // the trigger first.
    const firstItem = menuPopupRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
    firstItem?.focus()
  }, [menuOpen])

  function closeMenu() {
    setMenuOpen(false)
    menuButtonRef.current?.focus()
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // Esc is also handled by the document-level listener above (covers
    // focus landing outside the popup); this one only adds Tab-out closing
    // the menu, same as a click outside would.
    if (event.key === 'Tab') setMenuOpen(false)
  }

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
      title={wasTruncated ? undefined : title}
      {...{ [PRODUCT_OPEN_CONTROL_ATTR]: true }}
      onClick={(event) => openProduct(event.currentTarget)}
    >
      {title}
    </button>
  ) : (
    <p className="match-card__product" title={wasTruncated ? undefined : title}>
      {title}
    </p>
  )

  // S14-05 (F5) — "+N fonte(s)" pill, a different mechanism from the S7-11
  // "Visto em: <names>" line below (same rule/price chained over time vs.
  // same product/price across sources): both can render at once. S16-03
  // (03): the comp counts the OTHER sources, not this one — "+1 fonte" for
  // seen_count 2, never "Visto em 2 fontes" again.
  const seenCount = match.seen_count ?? 1
  const otherSourcesCount = seenCount - 1
  const showSeenBadge = otherSourcesCount > 0
  const seenBadgeLabel = `+${otherSourcesCount} ${otherSourcesCount === 1 ? 'fonte' : 'fontes'}`
  // S14-06 (F7) manual-edit fields.
  const priceUnidentified = match.price_cents === null
  const manuallyEdited = match.price_source === 'manual'

  const hasCashCard = match.price_cash_cents !== null && match.price_card_cents !== null
  const showTargetGapLine =
    !hasCashCard && !match.target_hit && match.target_price_cents !== null && match.target_gap_pct !== null
  // S16-03 (06): the alternative caption when there's no target to chase —
  // "−6%/+3% vs. média 30d", computed off `match.sparkline` alone (never a
  // number trusted from elsewhere). Mutually exclusive with the target-gap
  // line above (both read "no target" as their gate, just from either side).
  const averageDelta30d =
    !hasCashCard && match.target_price_cents === null
      ? computeAverageDelta30d(match.sparkline, match.price_cents)
      : null

  const metaText = [source?.name ?? `#${match.source_id}`, rule?.name ?? `#${match.rule_id}`]
    .concat(recipientNames.length > 0 ? [recipientNames.join(', ')] : [])
    .join(' · ')

  const canCreateRule = productKey !== null && onCreateRule !== undefined
  const canSnooze = productKey !== null && onSnooze !== undefined
  // S16-03 (02): "Corrigir"/"Corrigir preço" replaces "Definir alvo" outright
  // when the price needs a manual fix — never both at once.
  const canCorrect = productKey !== null && priceUnidentified && onOpenProduct !== undefined
  const canSetTarget = onSetTarget !== undefined && !canCorrect
  // S16-03 (05): narrow pulls Silenciar into the ⋯ menu; wide keeps it a
  // standalone button and the menu only ever holds "Criar regra disso".
  const showSnoozeButton = canSnooze && !isNarrow
  const showMenu = canCreateRule || (isNarrow && canSnooze)

  function submitTarget(event: FormEvent) {
    event.preventDefault()
    if (onSetTarget === undefined) return
    // S14-07 fix: this used to be `Math.round(Number(targetInput) * 100)`,
    // which reads the pt-BR thousands dot as a decimal point — "5.749"
    // silently became 575 cents (a R$ 5,75 target) instead of R$ 5.749.
    // S14-13: `parsePriceInput` is the one parser for every manually-typed
    // price in this app (mirrors `packages/rules/manual_price.py`'s fixed,
    // unambiguous format set, same pt-BR rejection messages) — this used to
    // be its own near-identical `manualPrice.ts` module.
    const parsed = parsePriceInput(targetInput)
    if (parsed.cents === null) {
      setTargetError(parsed.error)
      return
    }
    setTargetError(null)
    onSetTarget(match.rule_id, parsed.cents)
    setShowTargetForm(false)
  }

  return (
    <article
      ref={cardRef}
      className={'glass-card match-card' + (isLowestPriceEver ? ' match-card--aurora' : '')}
    >
      {/* S15-01: the icon only sits beside the heading (badges, title, meta)
          — price and actions below span the card's full width, as in the
          Claude Design comp, instead of living in a column indented by the
          icon. */}
      <div className="match-card__header">
        <div className="match-card__icon" style={{ background: CATEGORY_BACKGROUND[category], color: CATEGORY_ICON_COLOR[category] }}>
          <CategoryIcon category={category} />
        </div>
        <div className="match-card__body">
          {/* S16-03 (03): "preço não identificado" moved ahead of the
              delivery-status pill — matches the comp in both card widths,
              where the amber chip is the first thing the row says. */}
          <div className="match-card__badges">
            {match.target_hit && (
              <span className="match-card__badge match-card__badge--good">Alvo atingido</span>
            )}
            {priceUnidentified && (
              <span className="match-card__badge match-card__badge--warn">
                <span className="match-card__badge-dot" aria-hidden="true" />
                preço não identificado
              </span>
            )}
            <span
              className="match-card__status"
              style={{ background: status.background, color: status.foreground }}
            >
              <span className="match-card__status-dot" style={{ background: status.dotColor }} />
              {status.label}
            </span>
            {showSeenBadge && (
              <span className="match-card__badge match-card__badge--neutral">{seenBadgeLabel}</span>
            )}
            {manuallyEdited && (
              <span className="match-card__badge match-card__badge--manual">
                <span className="match-card__badge-dot" aria-hidden="true" />
                editado manualmente
              </span>
            )}
            {/* S15-01: moved up from the actions row, so that row only holds
                actions and fits on one line in the 2-column grid. */}
            <span className="match-card__timestamp">{formatMatchedAt(match.matched_at)}</span>
          </div>
          {wasTruncated ? <Tooltip label={linkCutText}>{productTitle}</Tooltip> : productTitle}
          {/* S16-03 (04): "Fonte · Regra · Destinatário", no labels — the
              full text still lives in `title` for whenever the CSS ellipsis
              (MatchCard.css) actually cuts it. */}
          <p className="match-card__meta" title={metaText}>
            {metaText}
          </p>
          {groupedSourceNames !== undefined && groupedSourceNames.length > 0 && (
            <p className="match-card__grouped-sources">Visto em: {groupedSourceNames.join(', ')}</p>
          )}
        </div>
      </div>

      {/* S14-07 (06b): `margin-top: auto` (MatchCard.css) pushes this row —
          and the actions row right after it — to the card's base, the same
          anchor for every card in a grid row regardless of how many
          badge/title lines sit above it. */}
      <div className="match-card__price-row">
        <div className="match-card__price-block">
          {priceUnidentified ? (
            // S16-03 (02): out of the 22px price slot entirely — a quieter
            // 16px amber line (same dot the badge above uses) plus the
            // "it enters history" hint, never fighting a real price for
            // attention.
            <div className="match-card__price-missing">
              <p className="match-card__price-missing-label">
                <span className="match-card__price-missing-dot" aria-hidden="true" />
                Preço não identificado
              </p>
              <p className="match-card__price-missing-hint">Corrija à mão — o valor entra no histórico.</p>
            </div>
          ) : match.price_cash_cents !== null && match.price_card_cents !== null ? (
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
          {averageDelta30d !== null && (
            <span
              className={
                'match-card__price-sub' +
                (averageDelta30d.belowAverage ? ' match-card__price-sub--good' : '')
              }
            >
              {averageDelta30d.pct > 0 ? '+' : ''}
              {averageDelta30d.pct}% vs. média 30d
            </span>
          )}
          {isLowestPriceEver && <span className="match-card__aurora-label">Menor preço já visto</span>}
        </div>
        <MatchSparkline match={match} />
      </div>

      {/* S14-07 (06b): its own border-top/padding-top, so the divider also
          aligns between cards in the same grid row. S16-03 (01/05): comp
          order — primary action, target/correct, Silenciar (wide only),
          then the trailing group (Abrir promoção + "⋯") pushed right. */}
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
        {canCorrect && (
          <button
            type="button"
            className="plane-action plane-action--compact match-card__action match-card__action--warn"
            {...{ [PRODUCT_OPEN_CONTROL_ATTR]: true }}
            onClick={(event) => openProduct(event.currentTarget)}
          >
            {isNarrow ? 'Corrigir' : 'Corrigir preço'}
          </button>
        )}
        {canSetTarget && (
          <button
            type="button"
            className="plane-action plane-action--secondary plane-action--compact match-card__action"
            aria-expanded={showTargetForm}
            onClick={() => {
              setTargetError(null)
              setShowTargetForm((current) => !current)
            }}
          >
            Definir alvo
          </button>
        )}
        {showSnoozeButton && (
          <button
            type="button"
            className="plane-action plane-action--secondary plane-action--compact match-card__action"
            // S15-01: short visible label so the comp buttons fit on one
            // row; the accessible name keeps the full "7 dias".
            aria-label={match.snoozed ? undefined : 'Silenciar 7 dias'}
            title={match.snoozed ? undefined : 'Silenciar por 7 dias'}
            onClick={() => onSnooze?.(match)}
          >
            {match.snoozed ? 'Reativar' : 'Silenciar'}
          </button>
        )}
        {/* S16-03 (01): the trailing group — pushed right, "Abrir promoção"
            text+icon on a wide card, icon-only (same accessible name) on a
            narrow one, then the "⋯" menu. */}
        {(match.message_link !== null || showMenu) && (
          <span className="match-card__links">
            {match.message_link !== null && (
              <a
                className={'match-card__link' + (isNarrow ? ' match-card__link--icon' : '')}
                href={match.message_link}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Abrir promoção"
              >
                {!isNarrow && 'Abrir promoção'}
                <span aria-hidden="true">↗</span>
              </a>
            )}
            {showMenu && (
              <span className="match-card__menu">
                <button
                  type="button"
                  ref={menuButtonRef}
                  className="match-card__menu-trigger"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-controls={menuOpen ? menuId : undefined}
                  aria-label="Mais ações"
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <span aria-hidden="true">⋯</span>
                </button>
                {menuOpen && (
                  <div
                    id={menuId}
                    ref={menuPopupRef}
                    role="menu"
                    className="glass-card match-card__menu-popup"
                    onKeyDown={handleMenuKeyDown}
                  >
                    {isNarrow && canSnooze && (
                      <button
                        type="button"
                        role="menuitem"
                        className="match-card__menu-item"
                        onClick={() => {
                          onSnooze?.(match)
                          closeMenu()
                        }}
                      >
                        {match.snoozed ? 'Reativar' : 'Silenciar 7 dias'}
                      </button>
                    )}
                    {canCreateRule && (
                      <button
                        type="button"
                        role="menuitem"
                        className="match-card__menu-item"
                        onClick={() => {
                          onCreateRule?.(productKey as string)
                          closeMenu()
                        }}
                      >
                        Criar regra disso
                      </button>
                    )}
                  </div>
                )}
              </span>
            )}
          </span>
        )}
      </div>

      {showTargetForm && canSetTarget && (
        <form className="match-card__target-form" onSubmit={submitTarget}>
          <label className="match-card__target-label">
            Alvo (R$)
            <input
              type="text"
              inputMode="decimal"
              placeholder="5.749,00"
              autoFocus
              aria-invalid={targetError !== null}
              aria-describedby={targetError !== null ? targetErrorId : undefined}
              value={targetInput}
              onChange={(event) => {
                setTargetInput(event.target.value)
                setTargetError(null)
              }}
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
          {targetError !== null && (
            <p id={targetErrorId} role="alert" className="match-card__target-error">
              {targetError}
            </p>
          )}
        </form>
      )}
    </article>
  )
}
