import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { NavCapsule } from './NavCapsule'

describe('NavCapsule', () => {
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
})
