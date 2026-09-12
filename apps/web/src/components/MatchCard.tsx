import { CategoryIcon } from './CategoryIcon'
import { categorize, CATEGORY_BACKGROUND } from './matchCategory'
import { summarizeDeliveryStatus } from './deliveryStatus'
import type { Match, Recipient, Rule, Source } from '../api/types'
import './MatchCard.css'
import '../components/GlassCard.css'

function formatPrice(cents: number | null): string {
  if (cents === null) return 'Preço não identificado'
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function MatchCard({
  match,
  rule,
  source,
  recipients,
}: {
  match: Match
  rule: Rule | undefined
  source: Source | undefined
  recipients: Recipient[]
}) {
  const category = categorize(match.message_text)
  const status = summarizeDeliveryStatus(match.deliveries)
  const recipientNames = match.deliveries
    .map((delivery) => recipients.find((recipient) => recipient.id === delivery.recipient_id)?.name)
    .filter((name): name is string => Boolean(name))

  return (
    <article className="glass-card match-card">
      <div className="match-card__icon" style={{ background: CATEGORY_BACKGROUND[category] }}>
        <CategoryIcon category={category} />
      </div>
      <div className="match-card__body">
        <p className="match-card__product">{match.message_text}</p>
        <p className="match-card__meta">
          Fonte: {source?.name ?? `#${match.source_id}`} · Regra: {rule?.name ?? `#${match.rule_id}`}
          {recipientNames.length > 0 && <> · Para: {recipientNames.join(', ')}</>}
        </p>
      </div>
      <p className="match-card__price">{formatPrice(match.price_cents)}</p>
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
