import { describe, expect, it } from 'vitest'
import { parseManualPriceCents, PriceParseError } from './manualPrice'

describe('parseManualPriceCents', () => {
  it.each([
    ['5.749,00', 574_900],
    ['5.749', 574_900],
    ['5749', 574_900],
    ['5749,9', 574_990],
    ['5749,90', 574_990],
    ['5749.50', 574_950],
    ['5749.5', 574_950],
    ['1.000.000', 100_000_000],
    ['1.234,56', 123_456],
    ['1.007', 100_700],
    ['6.991,5', 699_150],
    ['R$ 5.749,00', 574_900],
    ['R$ 5.749,90', 574_990],
    ['r$5749', 574_900],
    ['  5749  ', 574_900],
  ])('parses %s as %i cents', (input, expected) => {
    expect(parseManualPriceCents(input)).toBe(expected)
  })

  // The exact bug the Tech Lead flagged: `Number("5.749") * 100` reads the
  // dot as a decimal separator and silently turns R$ 5.749 into R$ 5,75.
  it('never mis-reads the pt-BR thousands dot as a decimal point', () => {
    expect(parseManualPriceCents('5.749')).toBe(574_900)
    expect(parseManualPriceCents('5.749')).not.toBe(575)
  })

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
  ])('rejects %s with a pt-BR message, never coercing it', (input, message) => {
    expect(() => parseManualPriceCents(input)).toThrow(PriceParseError)
    expect(() => parseManualPriceCents(input)).toThrow(message)
  })
})
