import { describe, expect, it } from 'vitest'
import { categorize } from './matchCategory'

describe('categorize', () => {
  it.each([
    ['Promoção iPhone 15 128GB por R$ 3.899', 'phone'],
    ['Notebook Lenovo IdeaPad 3', 'laptop'],
    ['Fone Sony WH-1000XM5 com cancelamento de ruído', 'headphones'],
    ['PlayStation 5 Slim disponível', 'gaming'],
    ['Air Fryer 5L em promoção', 'generic'],
  ] as const)('categorizes %s as %s', (text, expected) => {
    expect(categorize(text)).toBe(expected)
  })

  it('is case-insensitive', () => {
    expect(categorize('IPHONE 15 BARATO')).toBe('phone')
  })
})
