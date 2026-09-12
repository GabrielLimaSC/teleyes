import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SaudePage } from './SaudePage'

vi.mock('../auth/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/AuthContext')>()
  return {
    ...actual,
    useAuth: () => ({
      status: 'authenticated',
      adminId: 1,
      csrfMissing: false,
      csrfToken: 'test-csrf',
      login: vi.fn(),
      logout: vi.fn(),
    }),
  }
})

class InertEventSource {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  addEventListener() {}
  close() {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const recipient = {
  id: 1,
  name: 'Gabriel',
  telegram_chat_id: '999',
  allowlisted: true,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
}

const health = {
  status: 'ok',
  env: 'development',
  version: '0.1.0',
  uptime_seconds: 90,
  telegram: { configured: false, state: 'not_configured' },
  bot: { configured: false, state: 'not_configured' },
}

beforeEach(() => {
  vi.stubGlobal('EventSource', InertEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SaudePage', () => {
  it('shows the not_configured state for Telegram, bot and the test result honestly', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/health') return Promise.resolve(jsonResponse(health))
      if (url === '/recipients') return Promise.resolve(jsonResponse([recipient]))
      if (url === '/notifications/test' && method === 'POST') {
        return Promise.resolve(
          jsonResponse({ delivered: false, status: 'not_configured', recipient_id: 1, chat_id: '999' }),
        )
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<SaudePage />)

    // both Telegram and Bot rows show "Não configurado" — one per real field.
    await waitFor(() => expect(screen.getAllByText('Não configurado')).toHaveLength(2))

    await user.selectOptions(await screen.findByLabelText('Destinatário'), '1')
    await user.click(screen.getByRole('button', { name: 'Enviar teste' }))

    expect(await screen.findByText('Não entregue — status: not_configured.')).toBeInTheDocument()
  })

  it('surfaces the real API error when the recipient is not eligible', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/health') return Promise.resolve(jsonResponse(health))
      if (url === '/recipients') return Promise.resolve(jsonResponse([recipient]))
      if (url === '/notifications/test' && method === 'POST') {
        return Promise.resolve(
          jsonResponse({ detail: 'recipient must be active and allowlisted' }, 403),
        )
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<SaudePage />)

    await user.selectOptions(await screen.findByLabelText('Destinatário'), '1')
    await user.click(screen.getByRole('button', { name: 'Enviar teste' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('recipient must be active and allowlisted'),
    )
  })
})
