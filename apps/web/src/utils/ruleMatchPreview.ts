/**
 * Client-side preview of whether a sample message would match a rule —
 * mirrors packages/rules/normalize.py + packages/rules/match.py exactly
 * (lowercase, strip accents/punctuation, collapse whitespace; any include
 * term present and no exclude term present). This is a UI preview only: it
 * never calls the backend and has no effect on real matching, dedupe, or
 * persisted data. The real pipeline is the only source of truth for an
 * actual match.
 */
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g

function normalizeText(text: string): string {
  const withoutAccents = text.normalize('NFKD').replace(COMBINING_MARKS_RE, '')
  const withoutPunctuation = withoutAccents.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
  return withoutPunctuation.replace(/\s+/g, ' ').trim()
}

function parseTerms(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
}

export function previewRuleMatch(
  messageText: string,
  includeTerms: string,
  excludeTerms: string | null | undefined,
): boolean {
  const normalizedMessage = normalizeText(messageText)
  const include = parseTerms(includeTerms)
  const exclude = parseTerms(excludeTerms)

  if (exclude.some((term) => normalizedMessage.includes(normalizeText(term)))) return false
  return include.some((term) => normalizedMessage.includes(normalizeText(term)))
}
