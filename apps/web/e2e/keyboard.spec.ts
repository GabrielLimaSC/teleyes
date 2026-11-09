import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { E2E_PASSWORD, apiLogin, apiPost, apiPut, deleteMatchesFrom } from './helpers'

/**
 * S23-02: the main flows driven by the keyboard only (focus placement aside),
 * plus page titles, <html lang>, reduced motion and reflow.
 */

const tag = Math.random().toString(36).slice(2, 8)

/** Puts the sequential-focus starting point back at the top of the document. */
async function resetFocusStart(page: Page) {
  await page.evaluate(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    const marker = document.createElement('span')
    marker.tabIndex = -1
    document.body.prepend(marker)
    marker.focus()
    marker.remove()
  })
}

async function activeLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return el ? (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 60) : ''
  })
}

test('login by keyboard, skip link and page titles', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await expect(page).toHaveTitle('Entrar · teleyes')

  // First Tab stop is the skip link.
  await resetFocusStart(page)
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused()
  await page.getByLabel('Senha').focus()
  await page.keyboard.type(E2E_PASSWORD)
  await page.keyboard.press('Enter')
  await expect(page.getByText(/Sessão ativa/)).toBeVisible()
  await expect(page).toHaveTitle('Início · teleyes')

  await page.reload()
  await expect(page.getByText(/Sessão ativa/)).toBeVisible()
  await resetFocusStart(page)
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Pular para o conteúdo' })
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport()
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()

  for (const [route, title] of [
    ['/feed', 'Ofertas ao vivo'],
    ['/regras', 'Regras'],
    ['/fontes', 'Grupos'],
    ['/historico', 'Histórico'],
    ['/economia', 'Economia'],
    ['/saude', 'Saúde'],
    ['/configuracao', 'Configuração'],
  ] as const) {
    await page.goto(route)
    await expect(page).toHaveTitle(`${title} · teleyes`)
  }
})

test('rules: create, expand row and ⋯ menu with the keyboard', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')

  const name = `Teclado ${tag}`
  await page.getByLabel('Nome', { exact: true }).focus()
  await page.keyboard.type(name)
  await page.getByLabel(/O que você procura/).focus()
  await page.keyboard.type(`teclado${tag}`)
  await page.keyboard.press('Enter')
  const create = page.getByRole('button', { name: 'Criar regra' })
  await create.focus()
  await page.keyboard.press('Enter')

  const toggle = page.locator('.rule-row__toggle', { hasText: name }).first()
  await expect(toggle).toBeVisible()

  // Expand with Enter, collapse with Esc.
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.focus()
  await page.keyboard.press('Escape')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  // ⋯ menu: ArrowDown opens, arrows move, Esc closes and returns to the trigger.
  const trigger = page.getByRole('button', { name: new RegExp(`^Mais ações da regra ${name}`) })
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const first = await activeLabel(page)
  await page.keyboard.press('ArrowDown')
  expect(await activeLabel(page)).not.toBe(first)
  await page.keyboard.press('End')
  await expect(menu.getByRole('menuitem').last()).toBeFocused()
  await page.keyboard.press('Home')
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('product panel opens and closes with the keyboard, focus returns to the card', async ({ page }) => {
  await page.goto('/')
  const csrf = await apiLogin(page)
  await apiPut(page, '/settings/feed', csrf, { group_duplicates: false })
  const title = 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB'
  const source = await apiPost<{ id: number }>(page, '/sources', csrf, { name: `Loja Teclado ${tag}`, telegram_chat_id: `kb-${tag}` })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrf, { name: `Regra Teclado ${tag}`, include_terms: 'placa' })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrf, {
    name: `Dest Teclado ${tag}`,
    telegram_chat_id: `kb-r-${tag}`,
    allowlisted: true,
    rules_mode: 'selected',
    rule_ids: [rule.id],
  })
  await apiPost(page, '/demo/messages', csrf, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: `${title} por R$ 5.749`,
  })

  await page.goto('/feed')
  const card = page.locator('.match-card', { hasText: `Loja Teclado ${tag}` }).first()
  const open = card.getByRole('button', { name: /Abrir produto/ })
  await open.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('img', { name: /Menor .* último/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(open).toBeFocused()
})

test('purchase: register by keyboard; confirmation dialog traps focus and returns it', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/economia')

  const register = page.getByRole('button', { name: 'Registrar compra' })
  await register.focus()
  await page.keyboard.press('Enter')
  const form = page.getByRole('form', { name: 'Registrar compra' })
  await form.getByLabel('Peça ou categoria').focus()
  await page.keyboard.type(`Item Teclado ${tag}`)
  await page.keyboard.press('Tab')
  await page.keyboard.type('250,00')
  await page.keyboard.press('Enter')
  const row = page.getByRole('row', { name: new RegExp(`Item Teclado ${tag}`) })
  await expect(row).toBeVisible()

  const trigger = row.getByRole('button', { name: /Mais ações da compra/ })
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await page.getByRole('menuitem', { name: 'Excluir' }).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused()
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Shift+Tab')
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  await deleteMatchesFrom(page, `Loja Teclado ${tag}`)
  await page.close()
})

test('toast and new-alert announcements live in persistent polite regions', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')
  await expect(page.locator('main .sr-only[role="status"][aria-live="polite"]')).toHaveCount(1)
  await expect(page.locator('.toast-viewport[role="status"][aria-live="polite"]').first()).toBeAttached()
})

test('honors prefers-reduced-motion on the main screens', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await apiLogin(page)
  for (const route of ['/', '/feed', '/regras', '/fontes', '/historico', '/economia', '/saude']) {
    await page.goto(route)
    await page.waitForTimeout(400)
    const running = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => {
          const timing = animation.effect?.getComputedTiming()
          return animation.playState === 'running' && ((timing?.iterations ?? 1) === Infinity || Number(timing?.duration ?? 0) > 1)
        })
        .map((animation) => animation.id || (animation as CSSAnimation).animationName || 'anonymous'),
    )
    expect(running, route).toEqual([])
  }
})

test.describe('reflow', () => {
  for (const [label, width, height] of [
    ['200% zoom (720px)', 720, 450],
    ['400% zoom (320px)', 320, 640],
  ] as const) {
    test(`no horizontal scroll at ${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.goto('/')
      await apiLogin(page)
      for (const route of ['/', '/feed', '/regras', '/fontes', '/historico', '/economia', '/saude']) {
        await page.goto(route)
        await page.waitForTimeout(300)
        const [scrollWidth, clientWidth, offenders] = await page.evaluate(() => {
          const width = document.documentElement.clientWidth
          const wide = [...document.querySelectorAll('body *')]
            .filter((node) => node.getBoundingClientRect().right > width + 1)
            .slice(0, 5)
            .map((node) => `${node.tagName}.${String(node.className)}@${Math.round(node.getBoundingClientRect().right)}`)
          return [document.documentElement.scrollWidth, width, wide] as const
        })
        expect(scrollWidth, `${route} ${offenders.join(' | ')}`).toBeLessThanOrEqual(clientWidth + 1)
      }
    })
  }
})
