import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { listenerStatus } from '../test/listenerFixtures'
import { PendingChangesBanner } from './PendingChangesBanner'

describe('PendingChangesBanner', () => {
  it('shows nothing without pending changes', () => {
    const { container } = render(
      <PendingChangesBanner status={listenerStatus()} requesting={false} onApply={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('counts and names the changes and applies from inside the strip', async () => {
    const onApply = vi.fn()
    render(
      <PendingChangesBanner
        status={listenerStatus({
          has_unapplied_changes: true,
          unapplied_changes: [
            { entity: 'rule', action: 'edited', name: 'Fone bluetooth', fields: ['target_price'] },
            { entity: 'rule', action: 'created', name: 'SSD NVMe', fields: [] },
          ],
        })}
        requesting={false}
        onApply={onApply}
      />,
    )

    expect(screen.getByText('2 mudanças não aplicadas')).toBeInTheDocument()
    expect(screen.getByText(/preço-alvo de Fone bluetooth e nova regra SSD NVMe/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Descartar' })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Aplicar regras' }))
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('stays generic when the API does not know the detail', () => {
    render(
      <PendingChangesBanner
        status={listenerStatus({ has_unapplied_changes: true })}
        requesting={false}
        onApply={vi.fn()}
      />,
    )
    expect(screen.getByText('Há mudanças não aplicadas')).toBeInTheDocument()
  })
})
