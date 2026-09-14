import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeedPage } from './FeedPage'

class InertEventSource {
  addEventListener() {}
  close() {}
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

describe('FeedPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the empty state once loaded with no matches', async () => {
    vi.stubGlobal('EventSource', InertEventSource)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse([]))),
    )

    render(<FeedPage />)

    expect(await screen.findByText('Nenhum match ainda.')).toBeInTheDocument()
    expect(screen.getByText('Feed ao vivo')).toBeInTheDocument()
  })

  it('the "Atualizar" button reloads matches on demand (S7-02)', async () => {
    vi.stubGlobal('EventSource', InertEventSource)
    const fetchMock = vi.fn((_input: RequestInfo | URL) => Promise.resolve(jsonResponse([])))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<FeedPage />)
    await screen.findByText('Nenhum match ainda.')
    // FeedPage also fetches rules/sources/recipients on mount, all through
    // the same global fetch mock — assert the increase, not an absolute count.
    const callsBeforeRefresh = fetchMock.mock.calls.length

    await user.click(screen.getByRole('button', { name: 'Atualizar' }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/matches')).length,
      ).toBe(2),
    )
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRefresh)
  })
})
