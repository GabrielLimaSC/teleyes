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

/**
 * S10-02: S9-06 originally gated this cut on the term's relative position
 * (>= 50% of the text) — validated against only 2 examples at the time
 * (PC DO FAFA ~53%, the CMdias/S8-02 fixture ~16%), which broke on a third
 * real example (PC DO FAFA id 91, ~33%) once more real production data
 * became available. Pulled 87 real matches from PC DO FAFA/CMdias to
 * recalibrate: almost every real message puts the rule term's own line at
 * 20-45% (the "$ Valor .../💵 R$..." block after it is longer than the S9-06
 * mockup assumed), so a 50% floor almost never fired in practice — position
 * was never the right signal.
 *
 * What every one of those 87 messages *does* share: the rule term's own
 * line is followed, somewhere before the link, by a blank line (`\n\n`)
 * separating the product name from the price/coupon/footer block — present
 * even in real CMdias messages, despite the original S8-02 unit-test
 * fixture (single-line, no `\n\n` at all) not having one. Gating on real
 * paragraph structure instead of position: fires correctly on all 87 real
 * examples (including PC DO FAFA id 91), and the S8-02 fixture still falls
 * through unchanged (no `\n\n` anywhere in it) — same result as before,
 * confirmed against the exact fixture text, not just reasoned about.
 *
 * The gate only checks that a `\n\n` exists *somewhere after* the term ends
 * — never used as the cut point itself. A real counter-example in the
 * pulled data (a "ESTOQUE DISPONÍVEL!!!" banner line before the actual
 * product name, its own `\n\n` sitting *before* the rule term) would have
 * chopped the product name off entirely under a naive "cut at the first
 * `\n\n`" rule; anchoring the cut on the term's own position, same as
 * always, never has that failure mode.
 */
function hasBlankLineAfter(text: string, position: number): boolean {
  return text.indexOf('\n\n', position) !== -1
}

/**
 * S9-06: real promo text keeps going well past the point a human recognizes
 * the product — model numbers, seller boilerplate — so cut right after the
 * rule's own term instead of showing all of it. Extended to the next
 * whitespace so a term that's a substring of a longer word (rare, but
 * possible) never splits that word mid-way, same "never cut inside a word"
 * spirit as the S8-02 link cut. Falls back to `text` unchanged whenever the
 * term can't be found, or nothing after it looks like a paragraph break
 * (S10-02) — never hides information on a guess.
 */
function cutAtRuleTerm(text: string, rule: Rule | undefined): string {
  if (rule === undefined || text.length === 0) return text
  const termEnd = ruleTermEndIndex(text, rule.include_terms)
  if (termEnd === null) return text
  if (!hasBlankLineAfter(text, termEnd)) return text

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
