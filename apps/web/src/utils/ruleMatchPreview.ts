/**
 * Client-side preview of whether a sample message would match a rule —
 * mirrors packages/rules/normalize.py + packages/rules/match.py exactly
 * (lowercase, strip accents/punctuation, collapse whitespace; any include
 * term present and no exclude term present; a term with " + " needs every
 * part present, in any order). This is a UI preview only: it
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

const AND_SEPARATOR_RE = /\s+\+(?=\s)/

export const TERM_PART_EMPTY_MESSAGE =
  'Termo com "+" inválido: há uma parte vazia. Use o formato "memoria ram + 16gb", com texto dos dois lados do "+".'

/** Splits a term on " + " (plus with whitespace on both sides) BEFORE
 * normalization — normalizeText turns "+" into a space. Mirrors
 * packages/rules/match.py::split_term_parts. */
function splitTermParts(term: string): string[] {
  return ` ${term.trim()} `.split(AND_SEPARATOR_RE).map((part) => part.trim())
}

/** pt-BR error for a term with an empty "+" part, or null when well formed.
 * Mirrors packages/rules/match.py::terms_error. */
export function termsError(raw: string | null | undefined): string | null {
  for (const term of parseTerms(raw)) {
    const parts = splitTermParts(term)
    if (parts.length > 1 && parts.some((part) => normalizeText(part) === '')) {
      return TERM_PART_EMPTY_MESSAGE
    }
  }
  return null
}

function termMatches(term: string, normalizedMessage: string): boolean {
  const parts = splitTermParts(term)
    .map(normalizeText)
    .filter((part) => part !== '')
  if (parts.length === 0) return normalizedMessage.includes(normalizeText(term))
  return parts.every((part) => normalizedMessage.includes(part))
}

export function previewRuleMatch(
  messageText: string,
  includeTerms: string,
  excludeTerms: string | null | undefined,
): boolean {
  const normalizedMessage = normalizeText(messageText)
  const include = parseTerms(includeTerms)
  const exclude = parseTerms(excludeTerms)

  if (exclude.some((term) => termMatches(term, normalizedMessage))) return false
  return include.some((term) => termMatches(term, normalizedMessage))
}
