import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import { deleteRecipient, listRecipients, pauseRecipient } from '../api/recipients'
import { ApiError } from '../api/auth'
import { reportFailure } from '../api/demo'
import type { Recipient } from '../api/types'
import { StatusToggle } from '../components/StatusToggle'
import { useFillOrigin } from '../utils/useFillOrigin'
import '../components/CrudTable.css'
import '../components/FillButton.css'
import './RegrasPage.css'

/**
 * No nav tab exists for "Destinatários" — recipient management lives on the
 * Regras page, since that's where alert routing is configured. S21-02: the
 * create/edit form moved to the page's contextual right rail
 * (`RecipientRailForm`); this section keeps the list, pause and delete, and
 * reloads whenever the page bumps `version` after a save.
 */
export function DestinatariosSection({
  onChanged,
  version,
  editingId,
  onAdd,
  onEdit,
  headerExtra,
  onLoaded,
}: {
  onChanged?: () => void
  version: number
  editingId: number | null
  onAdd: () => void
  onEdit: (recipient: Recipient) => void
  headerExtra?: ReactNode
  onLoaded?: (recipients: Recipient[]) => void
}) {
  const { csrfToken } = useAuth()
  const fillOrigin = useFillOrigin()
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [pausingId, setPausingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const reload = () => {
    listRecipients(true)
      .then((data) => {
        setRecipients(data)
        onLoaded?.(data)
        setListError(null)
      })
      .catch(() => setListError('Não foi possível carregar os destinatários.'))
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [version])

  // S13-06: tells the page that the active recipients may differ from what the
  // listener loaded ("há mudanças não aplicadas").
  const changed = () => {
    reload()
    onChanged?.()
  }

  const handlePause = (recipient: Recipient) => {
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    setPausingId(recipient.id)
    pauseRecipient(csrfToken, recipient.id)
      .then(changed)
      .catch((error: unknown) => reportFailure(error, 'Não foi possível pausar o destinatário.', setListError))
      .finally(() => setPausingId(null))
  }

  const handleDelete = (recipient: Recipient) => {
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    setDeletingId(recipient.id)
    deleteRecipient(csrfToken, recipient.id)
      .then(changed)
      .catch((error: unknown) => {
        reportFailure(error, error instanceof ApiError ? error.message : 'Não foi possível excluir o destinatário.', setListError)
      })
      .finally(() => setDeletingId(null))
  }

  return (
    <section className="regras-section">
      <div className="regras-section-row">
        <div>
          <h2>Destinatários</h2>
          <p>Quem recebe os alertas</p>
        </div>
        <div className="regras-section-row__actions">
          {headerExtra}
          <button
            type="button"
            className="plane-action plane-action--secondary fill-button regras-section-row__button"
            onClick={onAdd}
            onPointerDown={fillOrigin}
          >
            + Adicionar destinatário
          </button>
        </div>
      </div>

      {loading && <p>Carregando…</p>}
      {listError && (
        <p role="alert" className="crud-page__error">
          {listError}
        </p>
      )}

      {!loading && !listError && (
        <div className="plane-pearl crud-table-wrap wide-table-wrap">
          <table className="crud-table wide-table">
            <thead>
              <tr>
                <th>Destinatário</th>
                <th>Chat ID</th>
                <th>Autorizado</th>
                <th>Status</th>
                <th className="wide-table__num">Ações</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((recipient) => (
                <tr
                  key={recipient.id}
                  className={
                    editingId === recipient.id
                      ? 'wide-table__row--editing'
                      : undefined
                  }
                >
                  <td className="crud-table__name" data-label="Destinatário">
                    {recipient.name}
                  </td>
                  <td data-label="Chat ID">{recipient.telegram_chat_id}</td>
                  <td data-label="Autorizado">{recipient.allowlisted ? 'Sim' : 'Não'}</td>
                  <td data-label="Status">
                    <StatusToggle
                      active={recipient.active}
                      pausing={pausingId === recipient.id}
                      onPause={() => handlePause(recipient)}
                    />
                  </td>
                  <td className="wide-table__actions" data-label="Ações">
                    <div className="wide-table__actions-inner">
                      <div className="wide-table__actions-row">
                        <button
                          type="button"
                          className="plane-action plane-action--secondary plane-action--compact"
                          onClick={() => onEdit(recipient)}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="plane-action plane-action--danger plane-action--compact"
                          onClick={() => handleDelete(recipient)}
                          disabled={deletingId === recipient.id}
                        >
                          Excluir
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
              {recipients.length === 0 && (
                <tr>
                  <td colSpan={5}>Nenhum destinatário cadastrado ainda.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
