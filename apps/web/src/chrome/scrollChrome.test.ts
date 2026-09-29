import { describe, expect, it } from 'vitest'
import { nextChromeMode } from './scrollChrome'

describe('nextChromeMode (S15-03)', () => {
  it('enters compact only well past the header', () => {
    expect(nextChromeMode('rest', 0)).toBe('rest')
    expect(nextChromeMode('rest', 140)).toBe('rest')
    expect(nextChromeMode('rest', 141)).toBe('compact')
  })

  it('leaves compact only near the very top (hysteresis, no flicker in between)', () => {
    expect(nextChromeMode('compact', 100)).toBe('compact')
    expect(nextChromeMode('compact', 24)).toBe('compact')
    expect(nextChromeMode('compact', 23)).toBe('rest')
  })
})
