import { CategoryIcon } from './CategoryIcon'
import { categorize, CATEGORY_BACKGROUND, CATEGORY_ICON_COLOR } from './matchCategory'
import { summarizeDeliveryStatus } from './deliveryStatus'
import { Tooltip } from './Tooltip'
import { cardTitle, productText } from './matchTitle'
import type { Match, Recipient, Rule, Source } from '../api/types'
import { formatMatchedAt } from '../utils/dates'
import './MatchCard.css'
import '../components/GlassCard.css'
import '../components/AuroraGlow.css'

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatPrice(cents: number | null): string {
  if (cents === null) return 'Preço não identificado'
  return formatCurrency(cents)
}

export function MatchCard({
  match,
  rule,
  source,
  recipients,
  isLowestPriceEver = false,
  groupedSourceNames,
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
}) {
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
  const productTitle = <p className="match-card__product">{title}</p>

  return (
    <article className={'glass-card match-card' + (isLowestPriceEver ? ' match-card--aurora' : '')}>
      <div className="match-card__icon" style={{ background: CATEGORY_BACKGROUND[category], color: CATEGORY_ICON_COLOR[category] }}>
        <CategoryIcon category={category} />
      </div>
      <div className="match-card__body">
        {wasTruncated ? <Tooltip label={linkCutText}>{productTitle}</Tooltip> : productTitle}
        <p className="match-card__meta">
          Fonte: {source?.name ?? `#${match.source_id}`} · Regra: {rule?.name ?? `#${match.rule_id}`}
          {recipientNames.length > 0 && <> · Para: {recipientNames.join(', ')}</>}
        </p>
        {groupedSourceNames !== undefined && groupedSourceNames.length > 0 && (
          <p className="match-card__grouped-sources">Visto em: {groupedSourceNames.join(', ')}</p>
        )}
        {/* S10-06: date + link on the same line (S10-05 comp's `.foot`) —
            were two separate sibling paragraphs before. */}
        <div className="match-card__foot">
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
        {/* S10-06: moved from beside the price into the body, right after
            the foot — was a `.side` sibling before. */}
        {isLowestPriceEver && <span className="match-card__aurora-label">Menor preço já visto</span>}
      </div>
      {/* S10-06: price + status now share one right-hand column (S10-05
          comp's `.side`) instead of being loose siblings after the body. */}
      <div className="match-card__side">
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
        <span
          className="match-card__status"
          style={{ background: status.background, color: status.foreground }}
        >
          <span className="match-card__status-dot" style={{ background: status.dotColor }} />
          {status.label}
        </span>
      </div>
    </article>
  )
}
