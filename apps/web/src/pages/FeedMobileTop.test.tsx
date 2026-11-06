import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FeedMobileTop } from './FeedMobileTop'
import type { FeedMobileTopProps } from './FeedMobileTop'
import type { Rule, Snooze } from '../api/types'

const rule = { id: 1, name: 'SSD NVMe' } as Rule
const snooze = { id: 9, label: 'Fone', scope: 'product' } as Snooze

function setup(over: Partial<FeedMobileTopProps> = {}) {
  const props: FeedMobileTopProps = {
    rules: [rule],
    ruleCounts: new Map([[1, 3]]),
    totalCount: 5,
    matchIds: [1, 2],
    loading: false,
    selectedRuleId: null,
    onSelectRule: vi.fn(),
    snoozes: [snooze],
    snoozeRemaining: () => '1 dia restante',
    onReactivate: vi.fn(),
    groupDuplicates: false,
    onToggleGroupDuplicates: vi.fn(),
    onRefresh: vi.fn(),
    targets: null,
    targetsCount: 0,
    sourcesList: null,
    sourcesCount: 0,
    ...over,
  }
  render(<FeedMobileTop {...props} />)
  return props
}

describe('FeedMobileTop', () => {
  it('selects a rule from the filter sheet', () => {
    const props = setup()
    expect(screen.getByText('Silenciados · 1')).toBeTruthy()
    fireEvent.click(screen.getByText('Todas as regras'))
    fireEvent.click(screen.getByText('SSD NVMe'))
    expect(props.onSelectRule).toHaveBeenCalledWith(1)
  })

  it('reactivates, toggles grouping and refreshes from the sheet', () => {
    const props = setup()
    fireEvent.click(screen.getByText('Silenciados · 1'))
    fireEvent.click(screen.getByText('Reativar'))
    fireEvent.click(screen.getByRole('switch', { name: /Agrupar duplicatas/ }))
    fireEvent.click(screen.getByText(/Atualizar/))
    expect(props.onReactivate).toHaveBeenCalledWith(9)
    expect(props.onToggleGroupDuplicates).toHaveBeenCalled()
    expect(props.onRefresh).toHaveBeenCalled()
  })

  it('refreshes when the list is pulled down past the threshold at the top (screen 32)', () => {
    const props = setup()
    const touch = (clientY: number) => ({ touches: [{ clientY }] })
    fireEvent.touchStart(window, touch(100))
    fireEvent.touchMove(window, touch(180))
    expect(screen.getByText('Puxe para atualizar')).toBeTruthy()
    fireEvent.touchMove(window, touch(300))
    expect(screen.getByText('Solte para atualizar')).toBeTruthy()
    fireEvent.touchEnd(window)
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Atualizando…')).toBeTruthy()
  })

  it('does not refresh on a short pull', () => {
    const props = setup()
    fireEvent.touchStart(window, { touches: [{ clientY: 100 }] })
    fireEvent.touchMove(window, { touches: [{ clientY: 140 }] })
    fireEvent.touchEnd(window)
    expect(props.onRefresh).not.toHaveBeenCalled()
  })
})
