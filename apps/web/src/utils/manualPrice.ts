/**
 * S14-07: mirrors `packages/rules/manual_price.py`'s same fixed set of
 * unambiguous pt-BR formats, same pt-BR rejection messages, same integer
 * arithmetic (never `Number(x) * 100` on the whole string, which is exactly
 * the bug this exists to avoid: `Number("5.749") * 100` reads the dot as a
 * decimal point and silently turns R$ 5.749 into R$ 5,75) — with one
 * intentional addition the Python mirror does not have yet: pt-BR thousands
 * grouping with a single decimal digit (`"6.991,5"`), needed for review 1
 * of this PR. Same rule as the 2-digit case: `,\d` always means cents, `.`
 * followed by exactly 3 digits always means a thousands group.
 *
 * Used client-side by the "Definir alvo" inline form (MatchCard) before
 * `PATCH /rules/{id}`'s `target_price_cents` — the backend has no endpoint
 * that parses free-text price into a rule's target, only `PATCH /matches/
 * {id}`'s own `price` field (a different value), so this cannot just call
 * the API and read back a 422.
 */

const PTBR_THOUSANDS_DECIMAL_RE = /^\d{1,3}(?:\.\d{3})+,\d{1,2}$/
const PTBR_THOUSANDS_RE = /^\d{1,3}(?:\.\d{3})+$/
const COMMA_DECIMAL_RE = /^\d+,\d{1,2}$/
const DOT_DECIMAL_RE = /^\d+\.\d{1,2}$/
const PLAIN_INTEGER_RE = /^\d+$/

const INVALID_FORMAT_MESSAGE = 'Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.'

export class PriceParseError extends Error {}

function reaisAndCents(reais: string, cents: string): number {
  return Number(reais) * 100 + Number(cents.padEnd(2, '0').slice(0, 2))
}

/** Parse a manually-typed price string into cents, or throw `PriceParseError`
 * with a pt-BR message ready to show inline — never silently coerces an
 * ambiguous value into a guessed amount. */
export function parseManualPriceCents(raw: string): number {
  let text = raw.trim()
  if (text.slice(0, 2).toLowerCase() === 'r$') text = text.slice(2).trim()
  if (text === '') throw new PriceParseError('Informe um preço.')

  let priceCents: number
  if (PTBR_THOUSANDS_DECIMAL_RE.test(text)) {
    const [reais, cents] = text.replace(/\./g, '').split(',')
    priceCents = reaisAndCents(reais, cents)
  } else if (PTBR_THOUSANDS_RE.test(text)) {
    priceCents = Number(text.replace(/\./g, '')) * 100
  } else if (COMMA_DECIMAL_RE.test(text)) {
    const [reais, cents] = text.split(',')
    priceCents = reaisAndCents(reais, cents)
  } else if (DOT_DECIMAL_RE.test(text)) {
    const [reais, cents] = text.split('.')
    priceCents = reaisAndCents(reais, cents)
  } else if (PLAIN_INTEGER_RE.test(text)) {
    priceCents = Number(text) * 100
  } else {
    throw new PriceParseError(INVALID_FORMAT_MESSAGE)
  }

  if (priceCents <= 0) throw new PriceParseError('O preço deve ser maior que zero.')
  return priceCents
}
