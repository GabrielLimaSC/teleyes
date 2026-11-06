import { describe, expect, it } from 'vitest'
import { INITIAL_MOBILE_SCROLL, stepMobileScroll } from './useMobileScrollChrome'
import type { MobileScrollState } from './useMobileScrollChrome'

const VIEW = 800
const DOC = 4000

function run(ys: number[], from: MobileScrollState = INITIAL_MOBILE_SCROLL) {
  return ys.reduce((state, y) => stepMobileScroll(state, y, VIEW, DOC), from)
}

describe('stepMobileScroll', () => {
  it('stays open near the top and marks scrolled past a few pixels', () => {
    expect(run([20, 60, 90]).compact).toBe(false)
    expect(run([0]).scrolled).toBe(false)
    expect(run([40]).scrolled).toBe(true)
  })

  it('folds after travelling down', () => {
    expect(run([100, 130, 180, 260]).compact).toBe(true)
  })

  it('does not flicker on small reversals', () => {
    const folded = run([100, 130, 180, 260])
    expect(run([264, 258, 266, 262], folded).compact).toBe(true)
  })

  it('unfolds after a real move up', () => {
    const folded = run([100, 130, 180, 260])
    expect(run([250, 238], folded).compact).toBe(false)
  })

  it('opens when resting near the end of the page, and at the top', () => {
    const folded = run([100, 130, 180, 260])
    expect(stepMobileScroll(folded, DOC - VIEW - 10, VIEW, DOC).compact).toBe(false)
    expect(stepMobileScroll(folded, 0, VIEW, DOC).compact).toBe(false)
  })
})
