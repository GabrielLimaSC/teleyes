import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { TermChipsInput } from './TermChipsInput'

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <TermChipsInput id="terms" label="Termos incluídos" value={value} onChange={setValue} />
      <output data-testid="stored">{value}</output>
      <button type="button">outro campo</button>
    </>
  )
}

const stored = () => screen.getByTestId('stored').textContent

describe('TermChipsInput', () => {
  it('shows the stored terms as chips', () => {
    render(<Harness initial="rtx 5070, rtx 5080" />)

    expect(screen.getByText('rtx 5070')).toBeInTheDocument()
    expect(screen.getByText('rtx 5080')).toBeInTheDocument()
  })

  it('Enter turns the typed text into a chip and stores it in the API format', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText('Termos incluídos'), 'rtx 5070{Enter}')
    await user.type(screen.getByLabelText('Termos incluídos'), 'ryzen 7{Enter}')

    expect(stored()).toBe('rtx 5070, ryzen 7')
    expect(screen.getByLabelText('Termos incluídos')).toHaveValue('')
  })

  it('a comma closes the term being typed', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText('Termos incluídos'), 'monitor 27,165hz,')

    expect(stored()).toBe('monitor 27, 165hz')
  })

  it('does not add a blank or repeated term', async () => {
    const user = userEvent.setup()
    render(<Harness initial="iphone" />)

    await user.type(screen.getByLabelText('Termos incluídos'), '   {Enter}')
    await user.type(screen.getByLabelText('Termos incluídos'), 'IPHONE{Enter}')

    expect(stored()).toBe('iphone')
  })

  it('the × on a chip removes just that term', async () => {
    const user = userEvent.setup()
    render(<Harness initial="rtx 5070, rtx 5080" />)

    await user.click(screen.getByRole('button', { name: 'Remover termo rtx 5070' }))

    expect(stored()).toBe('rtx 5080')
  })

  it('Backspace on an empty field removes the last chip, but not while typing', async () => {
    const user = userEvent.setup()
    render(<Harness initial="a, b" />)
    const input = screen.getByLabelText('Termos incluídos')

    await user.type(input, 'x{Backspace}')
    expect(stored()).toBe('a, b')

    await user.type(input, '{Backspace}')
    expect(stored()).toBe('a')
  })

  it('leaving the field commits what is still typed', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText('Termos incluídos'), 'último termo')
    await user.click(screen.getByRole('button', { name: 'outro campo' }))

    expect(stored()).toBe('último termo')
  })
})
