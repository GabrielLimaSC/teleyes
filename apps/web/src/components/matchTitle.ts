import type { Rule } from '../api/types'

/**
 * S11-04: extracted out of MatchCard.tsx unchanged so HistoricoPage's wide
 * table rows can show the exact same calibrated title as the Feed's cards,
 * instead of duplicating this logic (86 real messages went into tuning
 * `hasBlankLineAfter`'s gate below — a second, drifting copy would be a real
 * risk, not just style). MatchCard.tsx imports `cardTitle`/`productText`
 * from here now; behavior is identical, verified by its existing tests.
 */

export const FIRST_LINK_RE = /https?:\/\//i

/**
 * S8-02: real promo messages tend to end in one or more links plus a
 * boilerplate footer ("Cupom, preço e estoque por tempo limitado."), which
 * made the card grow to several lines showing content nobody reads. Cuts at
 * the link itself — a natural semantic boundary, never inside a word/phrase
 * (unlike the mid-word CSS ellipsis S7-02 removed on purpose). `message_text`
 * itself is never touched, only what this component renders.
 */
export function productText(messageText: string): string {
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

export function cardTitle(messageText: string, rule: Rule | undefined): string {
  const linkCut = productText(messageText)
  // The S8-02 "link near the start" fallback returns the full text with the
  // link still in it — never search for the rule term there, or the cut
  // could land past the link and put a raw URL back on the card.
  if (FIRST_LINK_RE.test(linkCut)) return linkCut
  return cutAtRuleTerm(linkCut, rule)
}
