import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { StatusToggle } from './StatusToggle'

describe('StatusToggle', () => {
  it('is a switch: active calls onPause', async () => {
    const onPause = vi.fn()
    const onResume = vi.fn()
    render(<StatusToggle active pausing={false} onPause={onPause} onResume={onResume} />)

    const toggle = screen.getByRole('switch', { name: 'ativa' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(toggle)

    expect(onPause).toHaveBeenCalledTimes(1)
    expect(onResume).not.toHaveBeenCalled()
  })

  it('paused calls onResume and is enabled', async () => {
    const onPause = vi.fn()
    const onResume = vi.fn()
    render(<StatusToggle active={false} pausing={false} onPause={onPause} onResume={onResume} />)

    const toggle = screen.getByRole('switch', { name: 'pausada' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).toBeEnabled()
    await userEvent.click(toggle)

    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onPause).not.toHaveBeenCalled()
  })

  it('is disabled and busy while a request runs', () => {
    render(<StatusToggle active pausing onPause={vi.fn()} onResume={vi.fn()} />)

    const toggle = screen.getByRole('switch')
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-busy', 'true')
  })

  it('stays disabled when paused without a resume action (sources, recipients)', () => {
    render(<StatusToggle active={false} pausing={false} onPause={vi.fn()} />)

    expect(screen.getByRole('switch', { name: 'pausada' })).toBeDisabled()
  })
})
