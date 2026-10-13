import { describe, expect, it } from 'vitest'
import { targetGapPct, targetHit } from './target'

describe('targetHit', () => {
  it('is true once the price is at or below the target', () => {
    expect(targetHit(2050_00, 2050_00)).toBe(true)
    expect(targetHit(1999_00, 2050_00)).toBe(true)
  })

  it('is false above the target, with no price, or with no target', () => {
    expect(targetHit(2249_00, 2050_00)).toBe(false)
    expect(targetHit(null, 2050_00)).toBe(false)
    expect(targetHit(2050_00, null)).toBe(false)
  })
})

describe('targetGapPct', () => {
  it('mirrors packages/rules/target.py: floors towards the target, never rounds up', () => {
    // 199/2050 = 9.70…%, floored to 9 — matches the backend's own docstring
    // example verbatim (packages/rules/target.py).
    expect(targetGapPct(2249_00, 2050_00)).toBe(9)
  })

  it('is 0 once the target is already hit, never negative', () => {
    expect(targetGapPct(2050_00, 2050_00)).toBe(0)
    expect(targetGapPct(1000_00, 2050_00)).toBe(0)
  })

  it('is null with no price, no target, or a non-positive target', () => {
    expect(targetGapPct(null, 2050_00)).toBeNull()
    expect(targetGapPct(2249_00, null)).toBeNull()
    expect(targetGapPct(2249_00, 0)).toBeNull()
  })
})
