import { render, screen } from '@testing-library/react'
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
})
