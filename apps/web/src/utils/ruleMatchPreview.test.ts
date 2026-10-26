import { describe, expect, it } from 'vitest'
import { previewRuleMatch, termsError } from './ruleMatchPreview'

describe('previewRuleMatch', () => {
  it('matches when an include term is present', () => {
    expect(previewRuleMatch('Promoção iPhone 15 por R$ 3.899', 'iphone', null)).toBe(true)
  })

  it('is case and accent insensitive, like the backend normalizer', () => {
    expect(previewRuleMatch('PROMOÇÃO IPHONE', 'iphone', null)).toBe(true)
    expect(previewRuleMatch('promocao iphone', 'IPHONE', null)).toBe(true)
  })

  it('does not match when no include term is present', () => {
    expect(previewRuleMatch('Samsung Galaxy em promoção', 'iphone', null)).toBe(false)
  })

  it('an exclude term vetoes an otherwise matching message', () => {
    expect(previewRuleMatch('iPhone usado, aceito troca', 'iphone', 'usado')).toBe(false)
  })

  it('supports comma-separated alternatives on both sides', () => {
    expect(previewRuleMatch('Notebook Gamer RTX 4060', 'notebook,laptop', null)).toBe(true)
    expect(previewRuleMatch('Notebook open box', 'notebook', 'usado, open box')).toBe(false)
  })

  describe('S17-06 " + " (all parts, any order) — parity with packages/rules/match.py', () => {
    const samsung = 'Memória Ram Samsung 16GB, Ddr5, 5600mhz'
    const corsair = 'Memória RAM Gamer Corsair Vengeance RGB 16GB DDR5'

    it('matches the real RAM titles with the brand in the middle', () => {
      expect(previewRuleMatch(samsung, 'memoria ram + 16gb ddr5', null)).toBe(true)
      expect(previewRuleMatch(corsair, 'memoria ram + 16gb ddr5', null)).toBe(true)
    })

    it('needs every part and ignores order', () => {
      expect(previewRuleMatch(samsung, '16gb + memoria ram', null)).toBe(true)
      expect(previewRuleMatch('Memória Ram Samsung 8GB', '16gb + memoria ram', null)).toBe(false)
      expect(previewRuleMatch('Pen drive 16GB', '16gb + memoria ram', null)).toBe(false)
    })

    it('a term without + stays one contiguous run', () => {
      expect(previewRuleMatch(samsung, 'memoria ram 16gb ddr5', null)).toBe(false)
      expect(previewRuleMatch('Memoria RAM 16GB DDR5 kit', 'memoria ram 16gb ddr5', null)).toBe(true)
    })

    it('blocked AND term vetoes only when all parts are present', () => {
      expect(previewRuleMatch('SSD Kingston 512GB', 'ssd', 'ssd + 512')).toBe(false)
      expect(previewRuleMatch('SSD Kingston 1TB', 'ssd', 'ssd + 512')).toBe(true)
    })

    it('a plain blocked term still blocks notebook listings', () => {
      expect(previewRuleMatch('Memória Ram 16GB para Notebook', 'memoria ram + 16gb', 'notebook')).toBe(false)
      expect(previewRuleMatch(corsair, 'memoria ram + 16gb', 'notebook')).toBe(true)
    })

    it('keeps + without spaces on both sides literal', () => {
      expect(previewRuleMatch('Roteador 5G+ novo', '5g+', null)).toBe(true)
      expect(previewRuleMatch('Linha A+ premium', 'a+', null)).toBe(true)
      expect(previewRuleMatch(samsung, 'memoria ram+ 16gb', null)).toBe(false)
    })

    it('flags empty parts exactly like the backend validator', () => {
      for (const term of ['memoria ram +', '+ 16gb', '+', 'a + ! + b', 'a +  + b']) {
        expect(termsError(term)).not.toBeNull()
      }
      for (const term of ['memoria ram + 16gb', '5g+', 'a+', 'iphone', 'a+ + b']) {
        expect(termsError(term)).toBeNull()
      }
      expect(termsError('ok, memoria ram +')).not.toBeNull()
      expect(termsError(null)).toBeNull()
    })
  })
})
