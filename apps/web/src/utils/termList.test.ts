import { describe, expect, it } from 'vitest'
import { addTerms, parseTermList, removeTerm, serializeTermList } from './termList'

describe('termList', () => {
  it('parses the API string into trimmed, non-empty terms', () => {
    expect(parseTermList('rtx 5070 ,  rtx 5080,,')).toEqual(['rtx 5070', 'rtx 5080'])
    expect(parseTermList('')).toEqual([])
  })

  it('drops repeats regardless of case, keeping the first spelling', () => {
    expect(parseTermList('iPhone, iphone, IPHONE, galaxy')).toEqual(['iPhone', 'galaxy'])
  })

  it('serializes to the comma-separated format the API stores', () => {
    expect(serializeTermList(['rtx 5070', 'rtx 5080'])).toBe('rtx 5070, rtx 5080')
    expect(serializeTermList([])).toBe('')
  })

  it('adds one or several comma-separated terms without repeating existing ones', () => {
    expect(addTerms('rtx 5070', 'rtx 5080')).toBe('rtx 5070, rtx 5080')
    expect(addTerms('rtx 5070', ' RTX 5070 , 4090 ')).toBe('rtx 5070, 4090')
    expect(addTerms('', 'a, b')).toBe('a, b')
  })

  it('removes a term case-insensitively and leaves the others', () => {
    expect(removeTerm('rtx 5070, rtx 5080', 'RTX 5070')).toBe('rtx 5080')
    expect(removeTerm('rtx 5070', 'rtx 5070')).toBe('')
  })
})
