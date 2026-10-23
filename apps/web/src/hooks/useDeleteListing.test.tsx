import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDeleteListing } from './useDeleteListing'

vi.mock('../auth/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/AuthContext')>()
  return { ...actual, useAuth: () => ({ csrfToken: 'tok' }) }
})

function Harness({
  showToast,
  onDeleted,
}: {
  showToast: (message: string, tone?: 'success' | 'error') => void
  onDeleted: () => void
}) {
  const { requestDeleteProduct, dialog } = useDeleteListing({ showToast, onDeleted })
  return (
    <>
      <button type="button" onClick={() => requestDeleteProduct('rtx-5070', 3)}>
        abrir
      </button>
      {dialog}
    </>
  )
}

afterEach(() => vi.restoreAllMocks())

describe('useDeleteListing product flow (S20-01)', () => {
  it('shows the record count in the confirmation and deletes all of them', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ deleted: 3 }), { status: 200 }))
    const showToast = vi.fn()
    const onDeleted = vi.fn()
    const user = userEvent.setup()
    render(<Harness showToast={showToast} onDeleted={onDeleted} />)

    await user.click(screen.getByRole('button', { name: 'abrir' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Excluir 3 registros deste produto? Isso remove o registro do histórico e dos cálculos de preço. Não dá para desfazer.',
    )
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Excluir produto' }))

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/products/rtx-5070/matches',
      expect.objectContaining({ method: 'DELETE', headers: { 'X-CSRF-Token': 'tok' } }),
    )
    expect(showToast).toHaveBeenCalledWith('3 registros excluídos.')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('Esc cancels without deleting', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const user = userEvent.setup()
    render(<Harness showToast={vi.fn()} onDeleted={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'abrir' }))
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a 404 as already deleted and still refreshes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Product not found' }), { status: 404 }),
    )
    const showToast = vi.fn()
    const onDeleted = vi.fn()
    const user = userEvent.setup()
    render(<Harness showToast={showToast} onDeleted={onDeleted} />)

    await user.click(screen.getByRole('button', { name: 'abrir' }))
    await user.click(screen.getByRole('button', { name: 'Excluir produto' }))

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(showToast).toHaveBeenCalledWith('Este anúncio já tinha sido excluído.')
  })
})
