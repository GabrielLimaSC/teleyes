import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RowActionsMenu } from './RowActionsMenu'

function setup() {
  const onFirst = vi.fn()
  const onDanger = vi.fn()
  render(
    <div>
      <button type="button">outside</button>
      <RowActionsMenu
        label="Mais ações"
        items={[
          { key: 'a', label: 'Duplicar', onSelect: onFirst },
          { key: 'b', label: 'Desabilitado', onSelect: vi.fn(), disabled: true },
          { key: 'c', label: 'Excluir', onSelect: onDanger, danger: true, separatorBefore: true },
        ]}
      />
    </div>,
  )
  return { onFirst, onDanger, user: userEvent.setup() }
}

describe('RowActionsMenu', () => {
  it('exposes the trigger as a menu button and toggles aria-expanded', async () => {
    const { user } = setup()
    const trigger = screen.getByRole('button', { name: 'Mais ações' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.click(trigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('moves focus to the first item and navigates with the arrow keys, skipping disabled items', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Mais ações' }))
    expect(screen.getByRole('menuitem', { name: 'Duplicar' })).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Excluir' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Duplicar' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Excluir' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('menuitem', { name: 'Duplicar' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Excluir' })).toHaveFocus()
  })

  it('opens with ArrowDown on the trigger', async () => {
    const { user } = setup()
    screen.getByRole('button', { name: 'Mais ações' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const { user } = setup()
    const trigger = screen.getByRole('button', { name: 'Mais ações' })
    await user.click(trigger)
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes on an outside click', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Mais ações' }))
    await user.click(screen.getByRole('button', { name: 'outside' }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('selecting an item runs it, closes the menu and returns focus to the trigger', async () => {
    const { user, onDanger, onFirst } = setup()
    const trigger = screen.getByRole('button', { name: 'Mais ações' })
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'Excluir' }))

    expect(onDanger).toHaveBeenCalledTimes(1)
    expect(onFirst).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('renders the menu in a portal on the body, outside any overflow container', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Mais ações' }))
    expect(screen.getByRole('menu').parentElement).toBe(document.body)
  })
})
