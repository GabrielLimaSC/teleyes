import { describe, expect, it } from 'vitest'
import { previewRuleMatch } from './ruleMatchPreview'

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
})
