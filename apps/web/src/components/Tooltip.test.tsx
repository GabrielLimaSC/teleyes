import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Tooltip } from './Tooltip'

describe('Tooltip', () => {
  it('renders the children and the label bubble', () => {
    render(
      <Tooltip label="Texto completo do título">
        <p>Título cortado</p>
      </Tooltip>,
    )

    expect(screen.getByText('Título cortado')).toBeInTheDocument()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Texto completo do título')
  })

  it('links the trigger to the bubble via aria-describedby, for screen readers', () => {
    render(
      <Tooltip label="Texto completo do título">
        <p>Título cortado</p>
      </Tooltip>,
    )

    const trigger = screen.getByText('Título cortado').parentElement as HTMLElement
    const bubble = screen.getByRole('tooltip')
    expect(trigger).toHaveAttribute('aria-describedby', bubble.id)
  })

  it('is keyboard-focusable, not just hoverable', () => {
    render(
      <Tooltip label="Texto completo do título">
        <p>Título cortado</p>
      </Tooltip>,
    )

    const trigger = screen.getByText('Título cortado').parentElement as HTMLElement
    expect(trigger).toHaveAttribute('tabIndex', '0')
  })
})
