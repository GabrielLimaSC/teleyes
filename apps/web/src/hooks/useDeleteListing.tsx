import { useState } from 'react'
import { ApiError } from '../api/auth'
import { deleteMatch } from '../api/matches'
import { deleteProductMatches } from '../api/products'
import { reportFailure } from '../api/demo'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import { ConfirmDialog } from '../components/ConfirmDialog'

export const DELETE_LISTING_MESSAGE =
  'Isso remove o registro do histórico e dos cálculos de preço. Não dá para desfazer.'

type DeleteTarget =
  | { kind: 'match'; matchId: number }
  | { kind: 'product'; productKey: string; count: number }

/**
 * S20-01: shared "Excluir anúncio" / "Excluir produto" flow for the Feed and
 * the Histórico — always behind a confirmation. `onDeleted` runs after the
 * server confirmed (reload the list, close the panel); `showToast` reports.
 */
export function useDeleteListing({
  showToast,
  onDeleted,
}: {
  showToast: (message: string, tone?: 'success' | 'error') => void
  onDeleted: (target: DeleteTarget) => void
}) {
  const { csrfToken } = useAuth()
  const [target, setTarget] = useState<DeleteTarget | null>(null)
  const [busy, setBusy] = useState(false)

  async function confirm() {
    if (target === null) return
    if (csrfToken === null) {
      showToast(CSRF_MISSING_MESSAGE, 'error')
      setTarget(null)
      return
    }
    setBusy(true)
    try {
      if (target.kind === 'match') {
        await deleteMatch(csrfToken, target.matchId)
        showToast('Anúncio excluído.')
      } else {
        const { deleted } = await deleteProductMatches(csrfToken, target.productKey)
        showToast(deleted === 1 ? '1 registro excluído.' : `${deleted} registros excluídos.`)
      }
      setTarget(null)
      onDeleted(target)
    } catch (err) {
      // A 404 means it is already gone (another tab, a sibling) — refresh the list anyway.
      if (err instanceof ApiError && err.status === 404) {
        setTarget(null)
        showToast('Este anúncio já tinha sido excluído.')
        onDeleted(target)
      } else {
        reportFailure(
          err,
          err instanceof ApiError ? err.message : 'Não foi possível excluir agora.',
          (message) => showToast(message, 'error'),
        )
      }
    } finally {
      setBusy(false)
    }
  }

  const dialog =
    target === null ? null : (
      <ConfirmDialog
        title={target.kind === 'match' ? 'Excluir este anúncio?' : 'Excluir este produto?'}
        message={
          target.kind === 'match'
            ? `Excluir este anúncio? ${DELETE_LISTING_MESSAGE}`
            : `Excluir ${target.count} ${target.count === 1 ? 'registro' : 'registros'} deste produto? ${DELETE_LISTING_MESSAGE}`
        }
        confirmLabel={target.kind === 'match' ? 'Excluir anúncio' : 'Excluir produto'}
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setTarget(null)}
      />
    )

  return {
    requestDeleteMatch: (matchId: number) => setTarget({ kind: 'match', matchId }),
    requestDeleteProduct: (productKey: string, count: number) =>
      setTarget({ kind: 'product', productKey, count }),
    dialog,
  }
}
