import { describe, expect, it } from 'vitest'
import { usesAdvancedFields } from './formMode'
import { RULE_TEMPLATES } from './templates'
import { parseTermList } from '../utils/termList'
import { termsError } from '../utils/ruleMatchPreview'

describe('RULE_TEMPLATES (S23-05)', () => {
  it('ships the eight generic categories with unique ids', () => {
    expect(RULE_TEMPLATES.map((template) => template.label)).toEqual([
      'Placa de vídeo',
      'Processador',
      'Memória RAM',
      'SSD',
      'Monitor',
      'Notebook',
      'Celular',
      'Fone de ouvido',
    ])
    expect(new Set(RULE_TEMPLATES.map((template) => template.id)).size).toBe(RULE_TEMPLATES.length)
  })

  it('every template has valid include and blocked terms the API accepts', () => {
    for (const template of RULE_TEMPLATES) {
      expect(parseTermList(template.includeTerms).length).toBeGreaterThan(0)
      expect(parseTermList(template.excludeTerms)).toContain('usado')
      expect(termsError(template.includeTerms)).toBeNull()
      expect(termsError(template.excludeTerms)).toBeNull()
      expect(usesAdvancedFields(template)).toBe(true)
    }
  })

  it('uses the "a + b" form where it makes sense', () => {
    const ssd = RULE_TEMPLATES.find((template) => template.id === 'ssd')
    expect(ssd?.includeTerms).toBe('ssd + 1tb')
  })
})
