/**
 * S11-05: the rule form edits include terms as chips, but the API keeps
 * `include_terms` as one comma-separated string (the backend splits it the
 * same way in `packages/rules`). These two helpers are the only place that
 * string <-> list conversion lives, so the chip UI can never drift from the
 * format the API and the rule tester (`ruleMatchPreview.ts`) already read.
 */

/** Splits a stored terms string into trimmed, non-empty terms, dropping
 * repeats (case-insensitive — "iPhone" and "iphone" match the same
 * messages after the backend's normalization) and keeping the first
 * spelling. */
export function parseTermList(raw: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const part of raw.split(',')) {
    const term = part.trim()
    const key = term.toLowerCase()
    if (term === '' || seen.has(key)) continue
    seen.add(key)
    terms.push(term)
  }
  return terms
}

export function serializeTermList(terms: string[]): string {
  return terms.join(', ')
}

/** Adds every comma-separated term in `additions` to `current`, skipping
 * blanks and repeats. Returns the updated stored string. */
export function addTerms(current: string, additions: string): string {
  return serializeTermList(parseTermList(`${current},${additions}`))
}

export function removeTerm(current: string, term: string): string {
  const key = term.toLowerCase()
  return serializeTermList(parseTermList(current).filter((candidate) => candidate.toLowerCase() !== key))
}
