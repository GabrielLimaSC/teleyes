import { describe, expect, it } from 'vitest'
import { savingsNoData, savingsOk } from '../economia/fixtures'
import { apiDateToInput, inputDateToApi } from './dates'
import { blackFridayLabel, formatSigned, savingLabel, savingTone } from './savings'

const plain = (text: string) => text.replaceAll(' ', ' ')

describe('savings labels', () => {
  it('shows a saving with the percentage, an overpayment with a minus sign and no data as such', () => {
    expect(plain(savingLabel(savingsOk()))).toBe('+R$ 350,00 (22,6%)')
    expect(plain(savingLabel(savingsOk({ saving_vs_median_cents: -5_000, saving_vs_median_pct: -4.2 })))).toBe(
      '−R$ 50,00 (-4,2%)',
    )
    expect(savingLabel(savingsNoData())).toBe('sem dados')
    expect(savingLabel(null)).toBe('—')
  })

  it('tones: good above, bad below, none without a figure', () => {
    expect(savingTone(savingsOk())).toBe('good')
    expect(savingTone(savingsOk({ saving_vs_median_cents: -1 }))).toBe('bad')
    expect(savingTone(savingsOk({ saving_vs_median_cents: 0 }))).toBe('neutral')
    expect(savingTone(savingsNoData())).toBe('none')
    expect(savingTone(null)).toBe('none')
  })

  it('formatSigned keeps zero unsigned', () => {
    expect(plain(formatSigned(0))).toBe('R$ 0,00')
  })

  it('counts days around the Black Friday', () => {
    expect(blackFridayLabel(38)).toBe('38 dias antes')
    expect(blackFridayLabel(1)).toBe('1 dia antes')
    expect(blackFridayLabel(0)).toBe('No dia da Black Friday')
    expect(blackFridayLabel(-3)).toBe('3 dias depois')
  })
})

describe('purchase date round trip', () => {
  it('keeps the picked day whatever the timezone (noon local)', () => {
    expect(apiDateToInput(inputDateToApi('2026-10-20'))).toBe('2026-10-20')
    expect(apiDateToInput(inputDateToApi('2026-01-01'))).toBe('2026-01-01')
  })
})
