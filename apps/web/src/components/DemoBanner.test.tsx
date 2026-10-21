import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEMO_READONLY_MESSAGE, notifyDemoReadOnly } from '../api/demo'
import { DemoBanner } from './DemoBanner'

const baseHealth = {
  status: 'ok',
  env: 'development',
  version: '0.1.0',
  uptime_seconds: 1,
  telegram: { configured: false, state: 'not_configured' },
  bot: { configured: false, state: 'not_configured' },
}

function stubHealth(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        ok
          ? new Response(JSON.stringify(body), { status: 200 })
          : new Response('{}', { status: 500 }),
      ),
    ),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.demo
})

describe('DemoBanner', () => {
  it('shows an accessible banner when the API reports demo mode', async () => {
    stubHealth({ ...baseHealth, demo: true })

    render(<DemoBanner />)

    const banner = await screen.findByRole('note', { name: 'Aviso de modo demonstração' })
    expect(banner).toHaveTextContent('Modo demonstração — dados fictícios')
    expect(document.documentElement.dataset.demo).toBe('true')
  })

  it('renders nothing outside demo mode', async () => {
    stubHealth(baseHealth)

    render(<DemoBanner />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(document.documentElement.dataset.demo).toBeUndefined()
  })

  it('renders nothing when health cannot be read', async () => {
    stubHealth({}, false)

    render(<DemoBanner />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })

  it('turns a refused write into the existing toast instead of crashing', async () => {
    stubHealth(baseHealth)
    render(<DemoBanner />)

    act(() => notifyDemoReadOnly())

    expect(await screen.findByRole('status')).toHaveTextContent(DEMO_READONLY_MESSAGE)
  })
})
