import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OfflineBanner } from './OfflineBanner'

function setOnLine(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true, writable: true })
}

describe('OfflineBanner', () => {
  afterEach(() => {
    setOnLine(true)
  })

  it('renders nothing while online', () => {
    setOnLine(true)
    render(<OfflineBanner />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows a banner immediately when mounted while already offline', () => {
    setOnLine(false)
    render(<OfflineBanner />)

    expect(screen.getByRole('status')).toHaveTextContent('Você está offline')
  })

  it('reacts to the browser online/offline events', () => {
    setOnLine(true)
    render(<OfflineBanner />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(screen.getByRole('status')).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
