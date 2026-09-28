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
 * Parses the strict set of price formats accepted by PATCH /matches/{id}.
 * A three-digit dot group is always a pt-BR thousands separator, so "5.749"
 * means 5,749 reais rather than 5.749 reais.
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
