import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S12-03 fidelity proof (opt-in, `VISUAL=1`): the dark theme of the app must be
 * the dark theme of the concept. The concept file is rendered in Chromium (its
 * own `support.js` makes the <x-dc> work offline) and, for each key component,
 * the computed colour/shape properties of the concept's element are compared,
 * one by one, with the app's element under `data-theme="dark"`. Any difference
 * not listed in ALLOWED (with its reason) fails.
 *
 *   VISUAL=1 npx playwright test e2e/dark-fidelity.spec.ts
 */
test.skip(process.env.VISUAL !== '1', 'fidelity proof is opt-in: set VISUAL=1')
test.use({ colorScheme: 'dark', timezoneId: 'UTC' })

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CONCEPT_DIR = path.join(REPO, '.impeccable', 'review', 's12-design')
const conceptUrl = (file: string) => 'file://' + encodeURI(path.join(CONCEPT_DIR, file))

const COLOR_PROPS = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-top-width',
  'border-top-style',
  'border-bottom-color',
  'box-shadow',
  'border-radius',
  'backdrop-filter',
]

/** Differences that are deliberate, keyed by "component :: property", with the
 * reason. Empty on purpose: everything compared below matches the concept.
 * (Not compared at all: typography and layout, and the navbar's backdrop-filter,
 * which is the app's own SVG refraction over the concept's plain blur.) */
const ALLOWED: Record<string, string> = {}

type Pair = {
  name: string
  /** JS source of `(el, cs) => boolean`, evaluated inside the concept page, over the elements of `screen`. */
  concept: { file?: string; screen?: string; find: string }
  /** CSS selector in the app (append ::before/::after for pseudos). */
  app: string
  props: string[]
  /** app value is the concatenation of these selectors' values (concept element = several app layers). */
  appJoin?: { selector: string; prop: string }[]
}

// Finder helpers, serialised into the concept page.
const TEXT_ELEMENT = (text: string) =>
  `(el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() === ${JSON.stringify(text)}`

async function conceptStyle(page: Page, spec: Pair['concept'], props: string[]): Promise<Record<string, string>> {
  return page.evaluate(
    ({ find, screen, props }) => {
      const scope = screen ? document.querySelector(`[id="2a"] [data-screen-label="${screen}"]`) : document.body
      if (!scope) throw new Error(`concept screen not found: ${screen}`)
      const test = eval(find) as (el: Element, cs: CSSStyleDeclaration) => boolean
      const el = [scope, ...scope.querySelectorAll('*')].find((candidate) => test(candidate, getComputedStyle(candidate)))
      if (!el) throw new Error(`concept element not found: ${find}`)
      const cs = getComputedStyle(el)
      return Object.fromEntries(props.map((prop) => [prop, cs.getPropertyValue(prop)]))
    },
    { find: spec.find, screen: spec.screen, props },
  )
}

async function appStyle(page: Page, selector: string, props: string[]): Promise<Record<string, string>> {
  const [base, pseudo] = selector.split('::')
  return page.locator(base).first().evaluate(
    (el, { props, pseudo }) => {
      const cs = getComputedStyle(el, pseudo ? `::${pseudo}` : undefined)
      return Object.fromEntries(props.map((prop) => [prop, cs.getPropertyValue(prop)]))
    },
    { props, pseudo },
  )
}

// concept predicates (element-level, run against computed style)
const hasBgImage = (fragment: string) => `(el, cs) => cs.backgroundImage.includes(${JSON.stringify(fragment)})`
const textIs = (text: string) => TEXT_ELEMENT(text)

const PAIRS: Pair[] = [
  {
    name: 'page background',
    concept: { screen: '02 Feed', find: '(el) => el.hasAttribute("data-screen-label")' },
    app: 'body::before',
    props: ['background-image'],
  },
  {
    name: 'page canvas',
    concept: { screen: '02 Feed', find: '(el) => el.hasAttribute("data-screen-label")' },
    app: 'body',
    props: ['background-color'],
  },
  {
    name: 'primary button',
    concept: { screen: '04 Regras', find: textIs('Nova regra') },
    app: '.regras-page__new-button',
    props: ['color', 'background-color', 'box-shadow', 'border-radius'],
  },
  {
    name: 'secondary button',
    concept: { screen: '04 Regras', find: textIs('Duplicar') },
    app: '.wide-table__actions button:nth-of-type(2)',
    props: ['color', 'background-color', 'border-top-color', 'border-top-width', 'border-radius'],
  },
  {
    name: 'danger button',
    concept: { screen: '04 Regras', find: textIs('Excluir') },
    app: '.wide-table__actions .plane-action--danger:last-of-type',
    props: ['color', 'background-color', 'border-top-color', 'border-top-width', 'border-radius'],
  },
  {
    name: 'field',
    concept: { screen: '04 Regras', find: textIs('Ex.: Monitor 27" 165Hz') },
    app: '.regras-form label input',
    props: ['background-color', 'border-top-color', 'border-top-width', 'border-radius'],
  },
  {
    name: 'field placeholder',
    concept: { screen: '04 Regras', find: textIs('Ex.: Monitor 27" 165Hz') },
    app: '.regras-form label input::placeholder',
    props: ['color'],
  },
  {
    name: 'term chip',
    concept: { screen: '04 Regras', find: textIs('monitor 27') },
    app: '.term-chips__chip',
    props: ['background-color', 'color', 'border-radius'],
  },
  {
    name: 'form label',
    concept: { screen: '04 Regras', find: textIs('Nome') },
    app: '.regras-form__field',
    props: ['color'],
  },
  {
    name: 'delivery pill',
    concept: { screen: '02 Feed', find: textIs('Notificação desativada') },
    app: '.match-card__status',
    props: ['background-color', 'color', 'border-radius'],
  },
  {
    name: 'glass rail',
    concept: { screen: '02 Feed', find: `(el, cs) => cs.backdropFilter.includes('blur(14px)') && cs.borderRadius === '18px'` },
    app: '.feed-rail',
    props: ['background-image', 'background-color', 'border-top-color', 'box-shadow', 'border-radius', 'backdrop-filter'],
  },
  {
    name: 'stat tile in a rail',
    concept: { screen: '02 Feed', find: `(el, cs) => cs.backgroundColor === 'rgba(255, 255, 255, 0.07)' && cs.borderRadius === '12px'` },
    app: '.feed-summary__tile',
    props: ['background-color', 'border-top-color', 'border-radius'],
  },
  {
    name: 'card',
    concept: { screen: '02 Feed', find: `(el, cs) => cs.borderRadius === '16px' && cs.backgroundImage.includes('rgb(27, 31, 39)') && cs.boxShadow.includes('0.34')` },
    app: '.match-card:not(.match-card--aurora)',
    props: ['background-image', 'border-top-color', 'border-top-width', 'box-shadow', 'border-radius'],
  },
  {
    name: 'lowest-price ring',
    concept: { screen: '02 Feed', find: hasBgImage('linear-gradient(120deg') },
    app: '.match-card--aurora::before',
    props: ['background-image'],
  },
  {
    name: 'lowest-price card fill',
    concept: { screen: '02 Feed', find: `(el, cs) => cs.borderRadius === '16.5px'` },
    app: '.match-card--aurora',
    props: ['background-image', 'box-shadow'],
  },
  {
    name: 'table head cell',
    concept: { screen: '04 Regras', find: `(el, cs) => cs.backgroundColor === 'rgb(30, 34, 42)'` },
    app: '.wide-table th',
    props: ['background-color'],
  },
  {
    name: 'toggle (on)',
    concept: { screen: '04 Regras', find: `(el, cs) => cs.backgroundColor === 'rgb(34, 197, 94)' && cs.borderRadius === '999px'` },
    app: '.status-toggle--active .status-toggle__knob',
    props: ['background-color'],
  },
]

const NAV_PAIRS: Pair[] = [
  {
    name: 'nav glass tint',
    concept: { file: 'NavCapsuleDark.dc.html', find: hasBgImage('linear-gradient') },
    app: '.nav-glass__tint',
    props: ['background-image', 'background-color'],
  },
  {
    name: 'nav glass rim',
    concept: { file: 'NavCapsuleDark.dc.html', find: hasBgImage('linear-gradient') },
    app: '.nav-glass__shine',
    props: ['border-top-color'],
  },
  {
    name: 'active tab',
    concept: { file: 'NavCapsuleDark.dc.html', find: `(el, cs) => cs.backgroundColor === 'rgb(242, 244, 248)' && el.tagName === 'A'` },
    app: '.nav-tab--active',
    props: ['color', 'background-color', 'box-shadow'],
  },
  {
    name: 'inactive tab',
    concept: { file: 'NavCapsuleDark.dc.html', find: `(el, cs) => el.tagName === 'A' && cs.color === 'rgb(196, 203, 216)'` },
    app: '.nav-tab:not(.nav-tab--active)',
    props: ['color'],
  },
]

const normalise = (value: string) => value.replace(/, none$/, '')

function diff(name: string, concept: Record<string, string>, app: Record<string, string>): string[] {
  return Object.keys(concept)
    .filter((prop) => normalise(concept[prop]) !== normalise(app[prop]) && !((`${name} :: ${prop}`) in ALLOWED))
    .map((prop) => `${name} :: ${prop}\n    concept: ${concept[prop]}\n    app:     ${app[prop]}`)
}

test('the dark app matches the dark concept, component by component', async ({ page, browser }) => {
  test.setTimeout(240_000)
  // ---- app, seeded like the concept's Feed/Regras ----
  await page.addInitScript(() => {
    ;(window as unknown as { EventSource: unknown }).EventSource = class {
      addEventListener() {}
      close() {}
    }
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const csrf = await apiLogin(page)
  await apiPost(page, '/sources', csrf, { name: 'Grupo de ofertas', telegram_chat_id: '-100950' })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrf, { name: 'Ryzen 7 9800X3D', include_terms: 'ryzen 7 9800x3d', max_price_cents: 700000 })
  const source = await apiPost<{ id: number }>(page, '/sources', csrf, { name: 'Outro grupo', telegram_chat_id: '-100951' })
  const rec = await apiPost<{ id: number }>(page, '/recipients', csrf, { name: 'Gabriel', telegram_chat_id: '950', allowlisted: true })
  for (const text of ['Processador AMD Ryzen 7 9800X3D por R$ 2.599', 'Processador AMD Ryzen 7 9800X3D por R$ 2.249']) {
    await apiPost(page, '/demo/messages', csrf, { source_id: source.id, rule_id: rule.id, recipient_ids: [rec.id], text })
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  const failures: string[] = []
  let compared = 0
  const compare = async (pair: Pair, concept: Page) => {
    const c = await conceptStyle(concept, pair.concept, pair.props)
    const a = await appStyle(page, pair.app, pair.props)
    compared += pair.props.length
    failures.push(...diff(pair.name, c, a))
  }

  const concept = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' })
  await concept.goto(conceptUrl('Teleyes Unificado.dc.html'))
  await concept.waitForSelector('[id="2a"] [data-screen-label="02 Feed"]')
  await concept.waitForTimeout(1500)

  // Feed
  await page.goto('/feed')
  await expect(page.locator('.match-card--aurora')).toHaveCount(1)
  for (const pair of PAIRS.filter((p) => p.concept.screen === '02 Feed' || p.name === 'page background')) await compare(pair, concept)

  // Regras (with chips typed so the chip exists)
  await page.goto('/regras')
  await page.getByLabel('Termos incluídos').fill('monitor 27,')
  await expect(page.locator('.term-chips__chip')).toHaveCount(1)
  await expect(page.locator('.wide-table th').first()).toBeVisible()
  for (const pair of PAIRS.filter((p) => p.concept.screen === '04 Regras')) await compare(pair, concept)

  // Navbar (its own concept file)
  const nav = await browser.newPage({ viewport: { width: 1440, height: 200 }, colorScheme: 'dark' })
  await nav.goto(conceptUrl('NavCapsuleDark.dc.html'))
  await nav.waitForTimeout(1500)
  await page.goto('/feed')
  const capsule = await (async () => {
    const c = await conceptStyle(nav, { find: hasBgImage('linear-gradient') }, ['background-image', 'border-top-color', 'box-shadow'])
    return c
  })()
  for (const pair of NAV_PAIRS) await compare(pair, nav)
  // The concept's single glass element = the app's shine (inset + ring) plus the capsule's outer shadow.
  const shine = await appStyle(page, '.nav-glass__shine', ['box-shadow'])
  const outer = await appStyle(page, '.nav-capsule__glass', ['box-shadow'])
  const joined = `${shine['box-shadow']}, ${outer['box-shadow']}`
  if (capsule['box-shadow'] !== joined) {
    failures.push(`nav glass shadow (rim + outer)\n    concept: ${capsule['box-shadow']}\n    app:     ${joined}`)
  }

  // Same for the mascot disc: inset rim (app .nav-mascot__shine) + outer glow (.nav-mascot).
  const disc = await conceptStyle(nav, { find: `(el, cs) => cs.width === '60px' && cs.borderRadius === '50%'` }, ['border-top-color', 'box-shadow'])
  const discRim = await appStyle(page, '.nav-mascot__shine', ['border-top-color', 'box-shadow'])
  const discOuter = await appStyle(page, '.nav-mascot', ['box-shadow'])
  if (disc['border-top-color'] !== discRim['border-top-color']) {
    failures.push(`mascot disc border\n    concept: ${disc['border-top-color']}\n    app:     ${discRim['border-top-color']}`)
  }
  const discShadow = `${discRim['box-shadow']}, ${discOuter['box-shadow']}`
  if (disc['box-shadow'] !== discShadow) {
    failures.push(`mascot disc shadow (rim + outer)\n    concept: ${disc['box-shadow']}\n    app:     ${discShadow}`)
  }

  // Not vacuous: every pair contributed its properties.
  expect(compared).toBeGreaterThan(50)
  console.log(`dark fidelity: ${PAIRS.length + NAV_PAIRS.length + 2} components, ${compared + 2} property comparisons, ${failures.length} differences`)
  expect(failures, `dark theme differs from the concept:\n${failures.join('\n')}`).toEqual([])
})

test('control: the same comparison FAILS against the light theme (the proof can tell themes apart)', async ({ page, browser }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => {
    localStorage.setItem('teleyes.theme', 'light')
    ;(window as unknown as { EventSource: unknown }).EventSource = class {
      addEventListener() {}
      close() {}
    }
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const csrf = await apiLogin(page)
  await apiPost(page, '/sources', csrf, { name: 'Grupo controle', telegram_chat_id: '-100960' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  const concept = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' })
  await concept.goto(conceptUrl('Teleyes Unificado.dc.html'))
  await concept.waitForSelector('[id="2a"] [data-screen-label="04 Regras"]')
  await concept.waitForTimeout(1500)
  await page.goto('/regras')
  await expect(page.locator('.wide-table th').first()).toBeVisible()

  const pair = PAIRS.find((candidate) => candidate.name === 'primary button')!
  const differences = diff(
    pair.name,
    await conceptStyle(concept, pair.concept, pair.props),
    await appStyle(page, pair.app, pair.props),
  )
  expect(differences.length).toBeGreaterThan(0)
})
