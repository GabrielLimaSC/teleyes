import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { ThemeToggle } from './ThemeToggle'
import { resetThemeForTests, THEME_STORAGE_KEY } from '../theme/theme'

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  resetThemeForTests()
})

describe('ThemeToggle', () => {
  it('says the state in words (aria-label and tooltip), starting at Sistema', () => {
    render(<ThemeToggle />)

    const button = screen.getByRole('button', { name: 'Tema: Sistema' })
    expect(button).toBeInTheDocument()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Tema: Sistema · clique para Claro')
    expect(button).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
  })

  it('one click cycles Sistema → Claro → Escuro → Sistema, and applies and stores each', async () => {
    const user = userEvent.setup()
    render(<ThemeToggle />)

    await user.click(screen.getByRole('button', { name: 'Tema: Sistema' }))
    expect(screen.getByRole('button', { name: 'Tema: Claro' })).toBeInTheDocument()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')

    await user.click(screen.getByRole('button', { name: 'Tema: Claro' }))
    expect(screen.getByRole('button', { name: 'Tema: Escuro' })).toBeInTheDocument()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    await user.click(screen.getByRole('button', { name: 'Tema: Escuro' }))
    expect(screen.getByRole('button', { name: 'Tema: Sistema' })).toBeInTheDocument()
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  it('is reachable and operable by keyboard', async () => {
    const user = userEvent.setup()
    render(<ThemeToggle />)

    await user.tab()
    expect(screen.getByRole('button', { name: 'Tema: Sistema' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Tema: Claro' })).toBeInTheDocument()
    await user.keyboard(' ')
    expect(screen.getByRole('button', { name: 'Tema: Escuro' })).toBeInTheDocument()
  })
})
