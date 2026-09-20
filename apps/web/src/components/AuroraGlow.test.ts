/// <reference types="node" />
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * S12-05: the "menor preço já visto" ring is only the card's edge. jsdom cannot
 * paint, so this pins the stylesheet itself (the pixel proof is
 * e2e/aurora.spec.ts): nothing that could draw outside the box or move.
 */
const css = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'AuroraGlow.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

describe('AuroraGlow.css', () => {
  it('has no blur, filter, shadow, animation or negative inset', () => {
    expect(css).not.toMatch(/blur\(/)
    expect(css).not.toMatch(/(^|[\s;{])filter\s*:/)
    for (const [, value] of css.matchAll(/box-shadow\s*:\s*([^;]+);/g)) expect(value.trim()).toBe('none')
    expect(css).not.toMatch(/@keyframes|@property|animation/)
    expect(css).not.toMatch(/inset\s*:\s*-/)
  })

  it('draws a static 120deg ring from the four ring tokens', () => {
    expect(css).toContain('linear-gradient(\n    120deg,')
    for (const stop of [1, 2, 3, 4]) expect(css).toContain(`var(--aurora-ring-${stop})`)
    expect(css).toContain('padding: 1.5px')
    expect(css).toContain('border-radius: 18px')
  })
})
