import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { HelpTip } from './HelpTip'

describe('HelpTip', () => {
  it('opens a dialog with the explanation, and Escape closes it and returns focus', async () => {
    const user = userEvent.setup()
    render(<HelpTip term="Preço máximo">O valor mais alto que você aceita pagar.</HelpTip>)
    const button = screen.getByRole('button', { name: 'Ajuda: Preço máximo' })
    await user.click(button)
    expect(screen.getByRole('dialog', { name: 'Preço máximo' })).toHaveTextContent('O valor mais alto')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })
})
