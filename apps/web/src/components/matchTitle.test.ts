import { describe, expect, it } from 'vitest'
import { cardTitle, productText } from './matchTitle'

/**
 * S16-03 (06): "Títulos sem ** do Telegram, 2 linhas com reticências" — the
 * 2-line clamp is CSS-only (MatchCard.css, covered by e2e), this file is the
 * actual string cleanup `productText`/`cardTitle` both build on.
 */
describe('matchTitle — Telegram markup cleanup (S16-03, 06)', () => {
  it('removes ** bold markers from the title', () => {
    expect(productText('**RTX 5070** por R$ 4.516')).toBe('RTX 5070 por R$ 4.516')
  })

  it('removes __ markers from the title', () => {
    expect(productText('__RTX 5070__ por R$ 4.516')).toBe('RTX 5070 por R$ 4.516')
  })

  it('collapses double (or more) spaces left behind into one', () => {
    expect(productText('RTX 5070   por  R$ 4.516')).toBe('RTX 5070 por R$ 4.516')
  })

  it('handles ** and double spaces together, same as a real Telegram message', () => {
    expect(productText('**RTX 5070**  por R$ 4.516  — oferta relâmpago')).toBe(
      'RTX 5070 por R$ 4.516 — oferta relâmpago',
    )
  })

  it('never touches a `\\n\\n` paragraph break — only literal spaces collapse', () => {
    // hasBlankLineAfter (the S10-02 cut gate) depends on this surviving.
    expect(productText('RTX 5070\n\npor R$ 4.516')).toBe('RTX 5070\n\npor R$ 4.516')
  })

  it('leaves already-clean text untouched', () => {
    expect(productText('RTX 5070 por R$ 4.516')).toBe('RTX 5070 por R$ 4.516')
  })

  it('cardTitle also returns the cleaned text when no rule term cut applies', () => {
    expect(cardTitle('**RTX 5070**  por R$ 4.516', undefined)).toBe('RTX 5070 por R$ 4.516')
  })
})
