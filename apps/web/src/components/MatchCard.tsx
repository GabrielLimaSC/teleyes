import { CategoryIcon } from './CategoryIcon'
import { categorize, CATEGORY_BACKGROUND } from './matchCategory'
import { summarizeDeliveryStatus } from './deliveryStatus'
import { Tooltip } from './Tooltip'
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

/** NFKD-decompose and drop combining marks, keeping length/position aligned
 * with the input for simple single-mark Portuguese accents (á, ã, ç, ...) —
 * good enough for the best-effort substring search below, same spirit as
 * `packages/rules/normalize.py` without its punctuation stripping (which
 * would break the offset alignment this needs). */
function foldAccents(text: string): string {
  return text.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/**
 * S9-06: best-effort match of `rule.include_terms` (comma-separated, same
 * format `apps/api/app/pipeline.py::parse_terms` splits on) against `text`,
 * case/accent-insensitive. Returns the end index of the *last*
 * matching term (several terms are alternatives — OR — so any of them may
 * be the one that's actually present), or `null` when none is found (rule
 * renamed since the match, or a mismatch too different for this
 * best-effort search to catch).
 */
function ruleTermEndIndex(text: string, includeTerms: string): number | null {
  const terms = includeTerms
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
  if (terms.length === 0) return null

  const foldedText = foldAccents(text)
  let lastEnd: number | null = null
  for (const term of terms) {
    const foldedTerm = foldAccents(term)
    if (foldedTerm.length === 0) continue
    const index = foldedText.lastIndexOf(foldedTerm)
    if (index === -1) continue
    const end = index + foldedTerm.length
    if (lastEnd === null || end > lastEnd) lastEnd = end
  }
  return lastEnd
}

// S9-06: two real messages from different sources disagreed on where the
// rule term sits. CMdias (S8-02 fixture) has it near the *start*, with real
// price/coupon content after it — cutting there would destroy the already-
// shipped S8-02 behavior. PC DO FAFA has it near the *end* of a long product
// name, with only SKU noise after it — cutting there is exactly the point of
// this task. A content-based filter ("don't cut if what follows looks like a
// price") doesn't separate them either — PC DO FAFA's trailing "$ Valor:..."
// looks just as price-like as CMdias's coupon text. Resolved positionally
// instead: only cut when the term's own end already sits in the second half
// of the text (>= 50%), i.e. only when the "product name" already accounts
// for most of it. Validated against both real examples (PC DO FAFA ~53% →
// cuts, CMdias ~16% → doesn't) — conservative heuristic, revisit if a third
// real example contradicts it. A tie at exactly 50% cuts (>=, not >).
const CUT_POSITION_THRESHOLD = 0.5

/**
 * S9-06: real promo text keeps going well past the point a human recognizes
 * the product — model numbers, seller boilerplate — so cut right after the
 * rule's own term instead of showing all of it. Extended to the next
 * whitespace so a term that's a substring of a longer word (rare, but
 * possible) never splits that word mid-way, same "never cut inside a word"
 * spirit as the S8-02 link cut. Falls back to `text` unchanged whenever the
 * term can't be found, or its end doesn't reach `CUT_POSITION_THRESHOLD` —
 * never hides information on a guess.
 */
function cutAtRuleTerm(text: string, rule: Rule | undefined): string {
  if (rule === undefined || text.length === 0) return text
  const termEnd = ruleTermEndIndex(text, rule.include_terms)
  if (termEnd === null) return text
  if (termEnd / text.length < CUT_POSITION_THRESHOLD) return text

  let end = termEnd
  while (end < text.length && !/\s/.test(text[end])) {
    end += 1
  }
  return text.slice(0, end).trimEnd()
}

function cardTitle(messageText: string, rule: Rule | undefined): string {
  const linkCut = productText(messageText)
  // The S8-02 "link near the start" fallback returns the full text with the
  // link still in it — never search for the rule term there, or the cut
  // could land past the link and put a raw URL back on the card.
  if (FIRST_LINK_RE.test(linkCut)) return linkCut
  return cutAtRuleTerm(linkCut, rule)
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
      <div className="match-card__icon" style={{ background: CATEGORY_BACKGROUND[category] }}>
        <CategoryIcon category={category} />
      </div>
      <div className="match-card__body">
        {wasTruncated ? <Tooltip label={linkCutText}>{productTitle}</Tooltip> : productTitle}
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
