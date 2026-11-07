import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SnoozeSheet, snoozeOptions } from './SnoozeSheet'

describe('SnoozeSheet', () => {
  it('computes the deadlines', () => {
    const options = snoozeOptions(new Date(2026, 10, 6, 9, 41))
    expect(options[0]?.hint).toBe('até amanhã, 09:41')
    expect(options[1]?.hint).toBe('até 13/11')
  })

  it('confirms the chosen duration', () => {
    const onConfirm = vi.fn()
    render(<SnoozeSheet ruleName="Fone bluetooth" open busy={false} onClose={() => {}} onConfirm={onConfirm} />)
    expect(screen.getByText('Preço-alvo atingido continua chegando na hora.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/Por 7 dias/))
    fireEvent.click(screen.getByRole('button', { name: 'Silenciar' }))
    expect(onConfirm).toHaveBeenCalledWith(7)
  })
})
