import { CategoryIcon } from './CategoryIcon'
import { categorize, CATEGORY_BACKGROUND } from './matchCategory'
import { summarizeDeliveryStatus } from './deliveryStatus'
import type { Match, Recipient, Rule, Source } from '../api/types'
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

function formatMatchedAt(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR')
}

const FIRST_LINK_RE = /https?:\/\//i

/**
 * S8-02: real promo messages tend to end in one or more links plus a
 * boilerplate footer ("Cupom, preço e estoque por tempo limitado."), which
 * made the card grow to several lines showing content nobody reads. Cuts at
 * the link itself — a natural semantic boundary, never inside a word/phrase
 * (unlike the mid-word CSS ellipsis S7-02 removed on purpose). `message_text`
 * itself is never touched, only what this component renders.
 */
function productText(messageText: string): string {
  const match = FIRST_LINK_RE.exec(messageText)
  if (match === null) return messageText
  const before = messageText.slice(0, match.index).trimEnd()
  // A link at (or near) the very start would otherwise leave an empty/near-
  // empty card — showing the full text is always better than showing
  // nothing.
  return before.length > 0 ? before : messageText
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

  return (
    <article className={'glass-card match-card' + (isLowestPriceEver ? ' match-card--aurora' : '')}>
      <div className="match-card__icon" style={{ background: CATEGORY_BACKGROUND[category] }}>
        <CategoryIcon category={category} />
      </div>
      <div className="match-card__body">
        <p className="match-card__product">{productText(match.message_text)}</p>
        <p className="match-card__meta">
          Fonte: {source?.name ?? `#${match.source_id}`} · Regra: {rule?.name ?? `#${match.rule_id}`}
          {recipientNames.length > 0 && <> · Para: {recipientNames.join(', ')}</>}
        </p>
        <p className="match-card__timestamp">{formatMatchedAt(match.matched_at)}</p>
        {groupedSourceNames !== undefined && groupedSourceNames.length > 0 && (
          <p className="match-card__grouped-sources">Visto em: {groupedSourceNames.join(', ')}</p>
        )}
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
      {match.price_cash_cents !== null && match.price_card_cents !== null ? (
        <div className="match-card__price-split">
          <span className="match-card__price-cash">À vista: {formatCurrency(match.price_cash_cents)}</span>
          <span className="match-card__price-card">Cartão: {formatCurrency(match.price_card_cents)}</span>
        </div>
      ) : (
        <p className="match-card__price">{formatPrice(match.price_cents)}</p>
      )}
      {isLowestPriceEver && <span className="match-card__aurora-label">Menor preço já visto</span>}
      <span
        className="match-card__status"
        style={{ background: status.background, color: status.foreground }}
      >
        <span className="match-card__status-dot" style={{ background: status.dotColor }} />
        {status.label}
      </span>
    </article>
  )
}
