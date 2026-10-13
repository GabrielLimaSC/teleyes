import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NavCapsule } from './NavCapsule'

describe('NavCapsule', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders all six pages and marks the current one active', () => {
    render(
      <MemoryRouter initialEntries={['/feed']}>
        <NavCapsule />
      </MemoryRouter>,
    )

    const labels = ['Login', 'Feed', 'Regras', 'Fontes', 'Histórico', 'Saúde']
    for (const label of labels) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
    }

    expect(screen.getByRole('link', { name: 'Feed' })).toHaveClass('nav-tab--active')
    expect(screen.getByRole('link', { name: 'Login' })).not.toHaveClass('nav-tab--active')
  })

  it('only marks Login active on the exact root path', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <NavCapsule />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Login' })).toHaveClass('nav-tab--active')
  })

  it('pins the navigation open from the mascot control', () => {
    const matchMedia = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...matchMedia(query),
      matches: query === '(max-width: 760px)',
    }))

    render(
      <MemoryRouter>
        <NavCapsule />
      </MemoryRouter>,
    )

    const mascot = screen.getByRole('button', { name: 'Expandir navegação' })
    expect(mascot).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(mascot)
    expect(screen.getByRole('button', { name: 'Recolher navegação' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByRole('navigation')).toHaveClass('nav-capsule--pinned')
  })
})
