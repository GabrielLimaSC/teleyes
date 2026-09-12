import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

test('saude page reflects the real not_configured state and tests a notification honestly', async ({
  page,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  await apiPost(page, '/recipients', csrfToken, {
    name: 'Gabriel Saude E2E',
    telegram_chat_id: '997',
    allowlisted: true,
  })

  await page.goto('/saude')

  await expect(page.getByText('Ambiente')).toBeVisible()
  // this E2E backend runs with no TG_API_ID/BOT_TOKEN (e2e/start-backend.sh) —
  // both real health fields must say so, never a faked "connected"/"configured".
  await expect(page.getByText('Não configurado')).toHaveCount(2)

  await page.getByLabel('Destinatário').selectOption({ label: 'Gabriel Saude E2E' })
  await page.getByRole('button', { name: 'Enviar teste' }).click()

  await expect(page.getByText('Não entregue — status: not_configured.')).toBeVisible()
})
