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
})
