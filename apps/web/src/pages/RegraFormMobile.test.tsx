import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listenerStatus } from '../test/listenerFixtures'
import { RegrasPage } from './RegrasPage'

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ status: 'authenticated', adminId: 1, csrfToken: 'test-csrf', login: vi.fn(), logout: vi.fn() }),
}))

const rule = {
  id: 1,
  name: 'iPhone',
  include_terms: 'iphone',
  exclude_terms: null,
  max_price_cents: 400_000,
  target_price_cents: null,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
  lowest_price_cents: null,
  lowest_price_24h_cents: null,
  snoozed_until: null,
  history_30d: [],
}

const json = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))

function stubPhone(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width: 640px') ? matches : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

describe('RegraFormMobile (S24-03c)', () => {
  beforeEach(() => {
    stubPhone(true)
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.startsWith('/listener/status')) return json(listenerStatus())
        if (url.startsWith('/rules/test')) return json({ total_matched: 0, window_days: 30, messages: [] })
        if (url.startsWith('/rules') && method === 'GET') return json([rule])
        if (url.startsWith('/digest')) return json({
            enabled: true,
            send_at_local: '09:00',
            top_n: 5,
            mute_individual: false,
            next_run_at_utc: '2026-09-25T12:00:00Z',
            next_run_at_local: '2026-09-25 09:00',
            queue_count: 0,
            queue: [],
          })
        if (url.startsWith('/snoozes') || url.startsWith('/recipients') || url.startsWith('/metrics')) return json([])
        if (url.startsWith('/matches')) return json([])
        return json([])
      }),
    )
  })

  afterEach(async () => {
    cleanup()
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.unstubAllGlobals()
  })

  it('opens "+ Nova regra" as a full-screen dialog with Cancelar and a fixed footer, and closes on Cancelar', async () => {
    const user = userEvent.setup()
    render(<RegrasPage />)
    await screen.findByText('iPhone')

    await user.click(screen.getByRole('button', { name: '+ Nova regra' }))

    const dialog = await screen.findByRole('dialog', { name: 'Nova regra' })
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Testar' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Salvar regra' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Nome')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Termos bloqueados')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Preço máximo (R$)')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Preço-alvo (R$)')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog', { name: 'Nova regra' })).not.toBeInTheDocument()
  })

  it('opens Editar from the row menu as "Editar regra" and asks before deleting', async () => {
    const user = userEvent.setup()
    render(<RegrasPage />)
    const row = (await screen.findByText('iPhone')).closest('tr') as HTMLElement

    await user.click(within(row).getByRole('button', { name: /^Mais ações da regra/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Editar' }))
    const dialog = await screen.findByRole('dialog', { name: 'Editar regra' })
    expect(within(dialog).getByRole('button', { name: 'Salvar alterações' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))

    await user.click(within(row).getByRole('button', { name: /^Mais ações da regra/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Excluir' }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Excluir a regra iPhone?')
  })
})
