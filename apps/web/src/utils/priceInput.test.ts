import { describe, expect, it } from 'vitest'
import { parseOptionalPriceInput, parsePriceInput } from './priceInput'

describe('parsePriceInput', () => {
  // S14-13: union of the two price-parsing test tables this module replaces
  // (`manualPrice.test.ts`'s and this file's own) — no case lost.
  it.each([
    ['5.749', 574_900],
    ['5.749,00', 574_900],
    ['5749', 574_900],
    ['1.007', 100_700],
    ['6.991,5', 699_150],
    ['5749,5', 574_950],
    ['5749,9', 574_990],
    ['5749,90', 574_990],
    ['5749.50', 574_950],
    ['5749.5', 574_950],
    ['1.000.000', 100_000_000],
    ['1.234,56', 123_456],
    ['R$ 5.749,00', 574_900],
    ['R$ 5.749,90', 574_990],
    ['r$5749', 574_900],
    ['  5749  ', 574_900],
  ])('parses %s as %i cents', (raw, expected) => {
    expect(parsePriceInput(raw)).toEqual({ cents: expected, error: null })
  })

  // The exact bug the Tech Lead flagged: `Number("5.749") * 100` reads the
  // dot as a decimal separator and silently turns R$ 5.749 into R$ 5,75.
  it('never mis-reads the pt-BR thousands dot as a decimal point', () => {
    expect(parsePriceInput('5.749')).toEqual({ cents: 574_900, error: null })
    expect(parsePriceInput('5.749').cents).not.toBe(575)
  })

  it.each(['0', '', 'abc', '1,999', '-10', '1.2.3', '5749,900', '5,749', '5.7492'])(
    'rejects %j',
    (raw) => {
      const result = parsePriceInput(raw)
      expect(result.cents).toBeNull()
      expect(result.error).toEqual(expect.any(String))
    },
  )

  it.each([
    ['', 'Informe um preço.'],
    ['   ', 'Informe um preço.'],
    ['0', 'O preço deve ser maior que zero.'],
    ['0,00', 'O preço deve ser maior que zero.'],
    ['-5749', 'Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.'],
    ['-10', 'Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.'],
    ['5749,900', 'Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.'],
    ['5,749', 'Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.'],
    ['1,999', 'Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.'],
    ['abc', 'Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.'],
    ['5.7492', 'Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.'],
    ['1.2.3', 'Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.'],
  ])('rejects %s with the exact pt-BR message, never coercing it', (raw, message) => {
    expect(parsePriceInput(raw)).toEqual({ cents: null, error: message })
  })
})

describe('parseOptionalPriceInput', () => {
  it('treats a blank string as "no value", never an error', () => {
    expect(parseOptionalPriceInput('')).toEqual({ cents: null, error: null })
    expect(parseOptionalPriceInput('   ')).toEqual({ cents: null, error: null })
  })

  it('parses a filled-in value exactly like parsePriceInput', () => {
    expect(parseOptionalPriceInput('5.749')).toEqual({ cents: 574_900, error: null })
    expect(parseOptionalPriceInput('abc')).toEqual({
      cents: null,
      error: 'Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.',
    })
  })
})
