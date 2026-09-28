export interface PriceInputSuccess {
  cents: number
  error: null
}

export interface PriceInputFailure {
  cents: null
  error: string
}

export type PriceInputResult = PriceInputSuccess | PriceInputFailure

const INVALID_FORMAT_MESSAGE =
  'Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.'

function digitsToInteger(digits: string): number | null {
  let value = 0
  for (const digit of digits) {
    value = value * 10 + (digit.charCodeAt(0) - 48)
    if (!Number.isSafeInteger(value)) return null
  }
  return value
}

function amountToCents(reais: string, decimal = ''): number | null {
  const whole = digitsToInteger(reais)
  const fractional = digitsToInteger(decimal.padEnd(2, '0') || '0')
  if (whole === null || fractional === null) return null
  const cents = whole * 100 + fractional
  return Number.isSafeInteger(cents) ? cents : null
}

/**
 * S14-13: the single parser for every manually-typed pt-BR price in this
 * app — `PATCH /matches/{id}`'s own `price` field (S14-06), the "Definir
 * alvo" inline form (MatchCard) and the product panel's "Avise-me abaixo
 * de" before `PATCH /rules/{id}`'s `target_price_cents`, and Regras'
 * "Teto"/"Alvo" and Histórico's preço mínimo/máximo filters. Used to live
 * split across two near-identical modules (`manualPrice.ts` returning
 * `{cents, error}` via a thrown `PriceParseError`, this one returning a
 * plain result) — merged into this one, keeping this module's `{cents,
 * error}` shape since it never needs a try/catch at the call site.
 *
 * A three-digit dot group is always a pt-BR thousands separator, so "5.749"
 * means 5,749 reais rather than 5.749 reais — never `Number(x) * 100` on the
 * whole string, which reads that dot as a decimal point and silently turns
 * R$ 5.749 into R$ 5,75.
 */
export function parsePriceInput(raw: string): PriceInputResult {
  let text = raw.trim()
  if (text.slice(0, 2).toLowerCase() === 'r$') text = text.slice(2).trim()
  if (!text) return { cents: null, error: 'Informe um preço.' }

  let cents: number | null = null
  let match: RegExpMatchArray | null

  if ((match = text.match(/^(\d{1,3}(?:\.\d{3})+),(\d{1,2})$/))) {
    cents = amountToCents(match[1].replaceAll('.', ''), match[2])
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(text)) {
    cents = amountToCents(text.replaceAll('.', ''))
  } else if ((match = text.match(/^(\d+),(\d{1,2})$/))) {
    cents = amountToCents(match[1], match[2])
  } else if ((match = text.match(/^(\d+)\.(\d{1,2})$/))) {
    cents = amountToCents(match[1], match[2])
  } else if (/^\d+$/.test(text)) {
    cents = amountToCents(text)
  } else {
    return { cents: null, error: INVALID_FORMAT_MESSAGE }
  }

  if (cents === null) return { cents: null, error: 'O preço informado é muito alto.' }
  if (cents <= 0) return { cents: null, error: 'O preço deve ser maior que zero.' }
  return { cents, error: null }
}

/**
 * Same parsing, for a field where leaving it blank is valid (Regras'
 * optional "Teto"/"Alvo", Histórico's optional preço mínimo/máximo) —
 * blank is `{ cents: null, error: null }`, never the "Informe um preço."
 * message `parsePriceInput` gives a required field.
 */
export function parseOptionalPriceInput(raw: string): { cents: number | null; error: string | null } {
  if (raw.trim() === '') return { cents: null, error: null }
  return parsePriceInput(raw)
}
