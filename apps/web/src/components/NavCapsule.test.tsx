import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NavCapsule } from './NavCapsule'
import { resetThemeForTests } from '../theme/theme'

function LocationProbe() {
  return <span data-testid="path">{useLocation().pathname}</span>
}

describe('NavCapsule', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders 4 | mascot | 4 in order, Tema included, and marks the current page', () => {
    render(
      <MemoryRouter initialEntries={['/feed']}>
        <NavCapsule />
      </MemoryRouter>,
    )

    const left = ['Início', 'Feed', 'Histórico', 'Economia']
    for (const label of left) expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
    const wings = document.querySelectorAll('.nav-capsule__wing')
    expect([...wings[0].querySelectorAll('.nav-tab')].map((el) => el.textContent)).toEqual(left)
    expect([...wings[1].querySelectorAll('.nav-tab')].map((el) => el.textContent)).toEqual([
      'Regras',
      'Fontes',
      'Saúde',
      'Tema',
    ])
    expect(screen.getByRole('button', { name: /^Tema: / })).toBeInTheDocument()

    const feed = screen.getByRole('link', { name: 'Feed' })
    expect(feed).toHaveClass('nav-tab--active')
    expect(feed).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Início' })).not.toHaveAttribute('aria-current')
  })

  it('only marks Início active on the exact root path', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <NavCapsule />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Início' })).toHaveClass('nav-tab--active')
    expect(screen.getByRole('link', { name: 'Feed' })).not.toHaveClass('nav-tab--active')
  })

  it('the mascot medallion goes home on wide screens and uses the theme-matching art', () => {
    window.localStorage.clear()
    resetThemeForTests()
    render(
      <MemoryRouter initialEntries={['/regras']}>
        <NavCapsule />
        <LocationProbe />
      </MemoryRouter>,
    )

    const mascot = screen.getByRole('button', { name: 'Ir para o início' })
    expect(mascot).not.toHaveAttribute('aria-expanded')
    expect(mascot.querySelector('img')?.getAttribute('src')).toMatch(/mascot\/mascote-(inverse|accent)\.png$/)
    fireEvent.click(mascot)
    expect(screen.getByTestId('path')).toHaveTextContent('/')
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
