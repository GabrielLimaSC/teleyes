import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Toast } from './Toast'
import type { ToastState } from '../hooks/useToast'

describe('Toast', () => {
  it('renders nothing when there is no toast', () => {
    const { container } = render(<Toast toast={null} onDismiss={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the message with a status role for screen readers', () => {
    const toast: ToastState = { id: 1, message: 'Regra criada.', tone: 'success' }
    render(<Toast toast={toast} onDismiss={vi.fn()} />)

    expect(screen.getByRole('status')).toHaveTextContent('Regra criada.')
  })

  it('applies the tone as a class for success and error', () => {
    const success: ToastState = { id: 1, message: 'ok', tone: 'success' }
    const { rerender } = render(<Toast toast={success} onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveClass('toast--success')

    const error: ToastState = { id: 2, message: 'falhou', tone: 'error' }
    rerender(<Toast toast={error} onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveClass('toast--error')
  })

  it('calls onDismiss when the close button is clicked', async () => {
    const onDismiss = vi.fn()
    const toast: ToastState = { id: 1, message: 'Regra criada.', tone: 'success' }
    const user = userEvent.setup()
    render(<Toast toast={toast} onDismiss={onDismiss} />)

    await user.click(screen.getByRole('button', { name: 'Fechar notificação' }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
