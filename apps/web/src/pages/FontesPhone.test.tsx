import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FontesPage } from './FontesPage'

vi.mock('../auth/AuthContext', () => ({
  CSRF_MISSING_MESSAGE: 'csrf ausente',
  useAuth: () => ({ csrfToken: 'test-csrf' }),
}))

const json = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }))

describe('FontesPage no celular (S24-04c)', () => {
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width: 640px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/sources/activity')) return json({ coverage_since: null, sources: [] })
        if (url.startsWith('/sources')) return json([])
        if (url === '/setup/status') return json({ configured: false })
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('abre "Adicionar grupo" numa folha com as ajudas recolhíveis', async () => {
    render(
      <MemoryRouter>
        <FontesPage />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '+ Novo' }))
    const sheet = await screen.findByRole('dialog', { name: 'Adicionar grupo' })
    expect(within(sheet).getByRole('tab', { name: 'Da minha conta' })).toBeInTheDocument()
    expect(within(sheet).getByRole('tab', { name: 'Por chat_id' })).toBeInTheDocument()
    expect(within(sheet).getByText('Como adicionar')).toBeInTheDocument()
    expect(within(sheet).getByText('Não aparece na lista?')).toBeInTheDocument()
  })
})
