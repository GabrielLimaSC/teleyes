import { describe, expect, it } from 'vitest'
import { parsePriceInput } from './priceInput'

describe('parsePriceInput', () => {
  it.each([
    ['5.749', 574_900],
    ['5.749,00', 574_900],
    ['5749', 574_900],
    ['1.007', 100_700],
    ['6.991,5', 699_150],
    ['5749,5', 574_950],
    ['5749.50', 574_950],
    ['R$ 5.749,00', 574_900],
  ])('parses %s as %i cents', (raw, expected) => {
    expect(parsePriceInput(raw)).toEqual({ cents: expected, error: null })
  })

  it.each(['0', '', 'abc', '1,999', '-10', '1.2.3'])('rejects %j', (raw) => {
    const result = parsePriceInput(raw)
    expect(result.cents).toBeNull()
    expect(result.error).toEqual(expect.any(String))
  })
})
