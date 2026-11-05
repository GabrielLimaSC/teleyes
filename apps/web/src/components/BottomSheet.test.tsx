import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { BottomSheet } from './BottomSheet'

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        abrir
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Ações">
        <button type="button">primeira</button>
      </BottomSheet>
    </div>
  )
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

// Unmounting an open sheet pops its history entry on a timer: let it land
// before the next test starts.
afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 20))
})

async function openSheet() {
  const user = userEvent.setup()
  render(<Harness />)
  await user.click(screen.getByRole('button', { name: 'abrir' }))
  return user
}

describe('BottomSheet', () => {
  it('is a modal dialog named by its title, with focus moved inside', async () => {
    await openSheet()
    const dialog = screen.getByRole('dialog', { name: 'Ações' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('button', { name: 'Fechar' })).toHaveFocus()
  })

  it('closes with the close button and returns focus to the opener', async () => {
    const user = await openSheet()
    await user.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'abrir' })).toHaveFocus()
    await settle()
  })

  it('closes with Escape', async () => {
    const user = await openSheet()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await settle()
  })

  it('closes when the backdrop is pressed, but not when the panel is', async () => {
    const user = await openSheet()
    await user.click(screen.getByText('Ações'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement
    await user.click(backdrop)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await settle()
  })

  it('closes on the browser back button, which pops its own history entry', async () => {
    await openSheet()
    expect(window.history.state).toHaveProperty('__teleyesSheet')
    await act(async () => {
      window.history.back()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(window.history.state?.__teleyesSheet).toBeUndefined()
  })

  it('pops its history entry when closed another way', async () => {
    const user = await openSheet()
    expect(window.history.state).toHaveProperty('__teleyesSheet')
    await user.keyboard('{Escape}')
    await settle()
    expect(window.history.state?.__teleyesSheet).toBeUndefined()
  })
})
