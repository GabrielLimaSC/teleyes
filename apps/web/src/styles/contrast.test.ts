/// <reference types="node" />
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * S12-03: measured, not estimated. Reads the DECLARED tokens of both themes
 * from styles/tokens.css + styles/materials.css and checks every text/background
 * pair the app actually paints against WCAG 2.x AA: 4.5:1 for text, 3:1 for
 * non-text parts that carry meaning (icons, the focus ring).
 *
 * Translucent backgrounds (glass, tiles) are composited over the worst
 * backdrop each theme can put behind them: the page canvas and the peak of
 * each background wash. Gradient backgrounds are checked at EVERY stop.
 *
 * Declared exceptions (also written out in the PR):
 *  - Borders of fields and cards (decoration; 1.5:1 light / 1.4:1 dark). The
 *    approved concept has them, in both themes; a separate, registered debt.
 *  - LIGHT_DEBT below: text pairs of the approved light theme that were already
 *    under 4.5:1 before dark mode existed. Listed with their measured ratio so
 *    that (a) a NEW failure fails the build and (b) fixing one forces the
 *    entry to be deleted. Changing the light look is not part of this task.
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (file: string) =>
  readFileSync(path.join(WEB_ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

type Theme = 'light' | 'dark'
type Rgba = { r: number; g: number; b: number; a: number }

// ---------- token parsing ----------

function blockAfter(css: string, selector: string, from = 0): [string, number] | null {
  const at = css.indexOf(selector, from)
  if (at === -1) return null
  const open = css.indexOf('{', at)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    if (css[i] === '}') depth -= 1
    if (depth === 0) return [css.slice(open + 1, i), i]
  }
  return null
}

function declarations(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[match[1]] = match[2].replace(/\s+/g, ' ').trim()
  return out
}

function themeTokens(): Record<Theme, Record<string, string>> {
  const files = ['src/styles/tokens.css', 'src/styles/materials.css'].map(read)
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}
  for (const css of files) {
    let cursor = 0
    for (let block = blockAfter(css, ':root', cursor); block; block = blockAfter(css, ':root', cursor)) {
      Object.assign(light, declarations(block[0]))
      cursor = block[1]
    }
    cursor = 0
    for (let block = blockAfter(css, "[data-theme='dark']", cursor); block; block = blockAfter(css, "[data-theme='dark']", cursor)) {
      Object.assign(dark, declarations(block[0]))
      cursor = block[1]
    }
  }
  return { light, dark: { ...light, ...dark } }
}

// ---------- color math ----------

function parseColor(text: string): Rgba {
  const value = text.trim().toLowerCase()
  if (value.startsWith('#')) {
    const hex = value.length === 4 ? [...value.slice(1)].map((c) => c + c).join('') : value.slice(1)
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 }
  }
  const match = value.match(/^rgba?\(([^)]+)\)$/)
  if (!match) throw new Error(`cannot parse color: ${text}`)
  const [r, g, b, a] = match[1].split(',').map((part) => Number.parseFloat(part))
  return { r, g, b, a: a ?? 1 }
}

const COLOR_IN_TEXT = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g
const colorsIn = (value: string) => (value.match(COLOR_IN_TEXT) ?? []).map(parseColor)

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a)
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a }
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(fg: Rgba, bg: Rgba): number {
  const l1 = luminance(over(fg, bg))
  const l2 = luminance(bg)
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/** Solid colors a (possibly translucent, possibly gradient) background can
 * take on top of each backdrop: one per gradient stop per backdrop. */
function backgroundCandidates(value: string, backdrops: Rgba[]): Rgba[] {
  const colors = colorsIn(value)
  const layers = value.includes('linear-gradient') && colors.length > 1 && /\),\s*(#|rgba?)/.test(value)
    ? // "linear-gradient(stops…), base": the last color is the base under the gradient
      { stops: colors.slice(0, -1), base: colors[colors.length - 1] }
    : { stops: colors, base: null }
  const out: Rgba[] = []
  for (const backdrop of backdrops) {
    const under = layers.base ? over(layers.base, backdrop) : backdrop
    for (const stop of layers.stops) out.push(over(stop, under))
  }
  return out
}

/** Worst backdrops a theme puts behind translucent surfaces: the canvas, and
 * the canvas under each background wash. A wash is at its full alpha only at
 * its centre (the top corners, under the navbar, and the bottom centre); the
 * rails, tiles and popovers below the header sit where it has faded, so for
 * them (`share` 0.5) each wash counts at half its peak alpha. The navbar
 * sits on the peaks (`share` 1). */
function backdropsOf(tokens: Record<string, string>, share: number): Rgba[] {
  const canvas = parseColor(tokens['color-paper'])
  const washes = colorsIn(tokens['body-wash']).map((wash) => ({ ...wash, a: wash.a * share }))
  return [canvas, ...washes.map((wash) => over(wash, canvas))]
}

// ---------- the pairs ----------

interface Pair {
  name: string
  fg: string // token name
  bg: string // token name (its value may be a gradient / translucent)
  min?: number // default 4.5
  onBackdrops?: 'nav' | 'content' // composite the bg over the page backdrops (see backdropsOf)
  under?: string // a solid token the bg sits on (e.g. a tile on the card)
}

const FIELD = 'plane-input-bg'
const PEARL = 'plane-pearl-bg'

const PAIRS: Pair[] = [
  // Text on the cards / tables (plano 1)
  ...['plane-text-primary', 'plane-text-heading', 'plane-text-secondary', 'plane-text-helper', 'plane-text-eyebrow'].map(
    (fg) => ({ name: `${fg} on card`, fg, bg: PEARL }),
  ),
  ...['plane-text-primary', 'plane-text-secondary', 'plane-text-helper'].map((fg) => ({
    name: `${fg} on table head / stat well`,
    fg,
    bg: 'plane-surface-sunken',
  })),
  { name: 'text on highlighted row', fg: 'plane-text-secondary', bg: 'plane-row-highlight' },
  { name: 'text on tint (chips, hints)', fg: 'plane-text-eyebrow', bg: 'plane-tint-bg' },
  { name: 'text on field', fg: 'plane-text-primary', bg: FIELD },
  { name: 'placeholder on field (only there)', fg: 'plane-text-placeholder', bg: FIELD },
  { name: 'disabled button label', fg: 'plane-text-helper', bg: 'plane-disabled-bg' },
  // Text on the glass rails and popovers (plano 3)
  ...['plane-text-primary', 'plane-text-secondary', 'plane-text-eyebrow', 'plane-text-helper-on-glass'].map((fg) => ({
    name: `${fg} on glass rail`,
    fg,
    bg: 'plane-glass-bg',
    onBackdrops: 'content',
  })),
  { name: 'text on stat tile in a rail', fg: 'plane-text-heading', bg: 'glass-tile-bg', onBackdrops: 'content', under: 'plane-glass-bg' },
  { name: 'label on stat tile in the Feed rail', fg: 'plane-text-eyebrow-on-glass', bg: 'glass-tile-bg', onBackdrops: 'content', under: 'plane-glass-bg' },
  { name: 'label on stat tile in the Login panel', fg: 'plane-text-eyebrow-on-glass', bg: 'glass-tile-bg', onBackdrops: 'content', under: 'plane-glass-bg' },
  { name: 'toast text', fg: 'color-text', bg: 'popover-bg', onBackdrops: 'content' },
  // Actions (plano 2)
  { name: 'primary button', fg: 'plane-action-primary-color', bg: 'plane-action-primary-bg' },
  { name: 'secondary button', fg: 'plane-text-primary', bg: 'plane-action-secondary-bg' },
  { name: 'danger button', fg: 'plane-action-danger-color', bg: 'plane-action-danger-bg' },
  { name: 'active nav tab', fg: 'nav-tab-active-text', bg: 'nav-tab-active-bg' },
  { name: 'nav tab', fg: 'nav-tab-text', bg: 'nav-tint', onBackdrops: 'nav' },
  // Status words on the card
  ...['good', 'warn', 'neutral', 'danger'].map((kind) => ({
    name: `plane-status-${kind} on card`,
    fg: `plane-status-${kind}`,
    bg: PEARL,
  })),
  { name: 'connection badge (warn)', fg: 'plane-status-warn', bg: 'plane-status-warn-bg' },
  ...['good', 'warn', 'neutral', 'danger'].map((kind) => ({
    name: `state-${kind}-text on card`,
    fg: `state-${kind}-text`,
    bg: PEARL,
  })),
  { name: 'offline banner', fg: 'offline-banner-text', bg: 'offline-banner-bg' },
  // Delivery-status pills
  ...['neutral', 'good', 'info', 'danger', 'warn'].map((kind) => ({
    name: `pill ${kind}`,
    fg: `pill-${kind}-fg`,
    bg: `pill-${kind}-bg`,
  })),
  // Neutral text of the glass-era surfaces (on the card)
  ...['text-strong', 'text-body', 'text-muted', 'text-faint', 'text-violet', 'text-violet-quiet'].map((fg) => ({
    name: `${fg} on card`,
    fg,
    bg: PEARL,
  })),
  // The flat CRUD layer (Fontes)
  { name: 'crud text', fg: 'color-text', bg: PEARL },
  { name: 'crud helper', fg: 'color-helper', bg: PEARL },
  { name: 'active toggle label', fg: 'toggle-label-active-color', bg: PEARL },
  // Non-text: icons on their tiles and the focus ring (3:1)
  ...['phone', 'laptop', 'headphones', 'gaming', 'generic'].map((kind) => ({
    name: `${kind} icon on its tile`,
    fg: `category-${kind}-icon`,
    bg: `category-${kind}-bg`,
    under: PEARL,
    min: 3,
  })),
  { name: 'focus ring on card', fg: 'plane-focus-color', bg: PEARL, min: 3 },
  { name: 'focus ring on field', fg: 'plane-focus-color', bg: FIELD, min: 3 },
  { name: 'nav focus ring', fg: 'nav-focus-ring-color', bg: 'nav-tint', onBackdrops: 'nav', min: 3 },
]

/** Known under-4.5 pairs of the approved LIGHT theme (see header). */
const LIGHT_DEBT: Record<string, string> = {
  'light: state-good-text on card': '4.31:1 — #1c8a4b (Saúde/Login state word)',
  'light: state-neutral-text on card': '3.37:1 — #8a8a92 ("Não configurado")',
  'light: text-faint on card': '3.37:1 — #8a8a92 (card meta)',
  'light: plane-text-helper-on-glass on glass rail': '4.23:1 — #606875 (Feed rail empty state)',
}

function worstRatio(theme: Theme, pair: Pair, tokens: Record<string, string>): number {
  const fgValue = tokens[pair.fg]
  const bgValue = tokens[pair.bg]
  if (fgValue === undefined || bgValue === undefined) throw new Error(`${theme}: unknown token in "${pair.name}"`)
  const fgs = colorsIn(fgValue)
  const base = pair.onBackdrops
    ? backdropsOf(tokens, pair.onBackdrops === 'nav' ? 1 : 0.5)
    : [parseColor(tokens['color-paper'])]
  const backdrops = pair.under ? backgroundCandidates(tokens[pair.under], base) : base
  const bgs = backgroundCandidates(bgValue, backdrops)
  let worst = Infinity
  for (const bg of bgs) for (const fg of fgs) worst = Math.min(worst, ratio(fg, bg))
  return worst
}

describe('contrast — the color math itself', () => {
  it('matches the WCAG reference values', () => {
    expect(ratio(parseColor('#000000'), parseColor('#ffffff'))).toBeCloseTo(21, 5)
    expect(ratio(parseColor('#777777'), parseColor('#ffffff'))).toBeCloseTo(4.48, 1)
    // the concept's own measured numbers (docs): placeholder on the field / on the card
    expect(ratio(parseColor('#79808d'), parseColor('#14171c'))).toBeGreaterThanOrEqual(4.5)
    expect(ratio(parseColor('#79808d'), parseColor('#1b1f27'))).toBeLessThan(4.5)
  })
})

const tokens = themeTokens()

for (const theme of ['light', 'dark'] as const) {
  describe(`contrast — ${theme} theme`, () => {
    for (const pair of PAIRS) {
      const min = pair.min ?? 4.5
      const key = `${theme}: ${pair.name}`
      it(`${pair.name} ≥ ${min}:1`, () => {
        const measured = worstRatio(theme, pair, tokens[theme])
        if (theme === 'light' && key in LIGHT_DEBT) {
          expect(measured, `${key} is listed as light debt but now passes: delete it from LIGHT_DEBT`).toBeLessThan(min)
        } else {
          expect(measured, `${key} measured ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(min)
        }
      })
    }
  })
}
