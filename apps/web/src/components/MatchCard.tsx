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

export function MatchCard({
  match,
  rule,
  source,
  recipients,
  isLowestPriceEver = false,
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
        <p className="match-card__product">{match.message_text}</p>
        <p className="match-card__meta">
          Fonte: {source?.name ?? `#${match.source_id}`} · Regra: {rule?.name ?? `#${match.rule_id}`}
          {recipientNames.length > 0 && <> · Para: {recipientNames.join(', ')}</>}
        </p>
        <p className="match-card__timestamp">{formatMatchedAt(match.matched_at)}</p>
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
