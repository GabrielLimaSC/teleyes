import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { listenerStatus } from '../test/listenerFixtures'
import { ListenerApplyPanel } from './ListenerApplyPanel'

function renderPanel(
  status: ReturnType<typeof listenerStatus> | null,
  overrides: { error?: string | null; requesting?: boolean } = {},
) {
  const onApply = vi.fn()
  render(
    <ListenerApplyPanel
      status={status}
      error={overrides.error ?? null}
      requesting={overrides.requesting ?? false}
      onApply={onApply}
    />,
  )
  return onApply
}

describe('ListenerApplyPanel', () => {
  it('shows nothing before the first answer, and the error if the first read failed', () => {
    const { container } = render(
      <ListenerApplyPanel status={null} error={null} requesting={false} onApply={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('a failed first read is announced, not hidden', () => {
    renderPanel(null, { error: 'Não foi possível consultar o estado do listener.' })

    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível consultar')
  })

  it('unapplied changes: the primary button applies', async () => {
    const onApply = renderPanel(listenerStatus({ has_unapplied_changes: true }))
    const user = userEvent.setup()

    expect(screen.getByText('Há mudanças ainda não aplicadas')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Aplicar regras' })
    expect(button).not.toHaveClass('plane-action--secondary')
    await user.click(button)

    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('nothing to apply: the button stays available but is secondary', () => {
    renderPanel(listenerStatus())

    expect(screen.getByText('Regras aplicadas')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aplicar regras' })).toHaveClass('plane-action--secondary')
  })

  it.each(['pending', 'applying'] as const)('%s: disabled, reads "Aplicando…"', (state) => {
    renderPanel(listenerStatus({ state }))

    expect(screen.getByRole('button', { name: 'Aplicando…' })).toBeDisabled()
  })

  it('is disabled right after the click, before the answer arrives', () => {
    renderPanel(listenerStatus({ has_unapplied_changes: true }), { requesting: true })

    expect(screen.getByRole('button', { name: 'Aplicando…' })).toBeDisabled()
  })

  it('a failure is announced with the class name and can be retried', async () => {
    const onApply = renderPanel(listenerStatus({ state: 'failed', error: 'ConnectionError' }))
    const user = userEvent.setup()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Não foi possível aplicar (ConnectionError). A configuração anterior continua ativa.',
    )
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }))

    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('a request error (e.g. no CSRF) is shown next to the state', () => {
    renderPanel(listenerStatus(), { error: 'Sessão sem token de segurança.' })

    expect(screen.getByRole('alert')).toHaveTextContent('Sessão sem token de segurança.')
  })
})
