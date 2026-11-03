import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import { deleteRecipient, listRecipients, pauseRecipient } from '../api/recipients'
import { ApiError } from '../api/auth'
import { reportFailure } from '../api/demo'
import type { DigestSettings, Recipient, Rule } from '../api/types'
import { useFillOrigin } from '../utils/useFillOrigin'
import '../components/CrudTable.css'
import '../components/FillButton.css'
import './RegrasPage.css'
import { RecipientCard } from './RecipientCard'

/**
 * No nav tab exists for "Destinatários" — recipient management lives on the
 * Regras page, since that's where alert routing is configured. S21-02: the
 * create/edit form moved to the page's contextual right rail
 * (`RecipientRailForm`); S21-07: each recipient is a card that also edits the
 * delivery behaviour (which rules, which alert types). The list reloads
 * whenever the page bumps `version` after a save.
 */
export function DestinatariosSection({
  onChanged,
  version,
  editingId,
  onAdd,
  onEdit,
  headerExtra,
  onLoaded,
  rules,
  digest,
}: {
  onChanged?: () => void
  version: number
  editingId: number | null
  onAdd: () => void
  onEdit: (recipient: Recipient) => void
  headerExtra?: ReactNode
  onLoaded?: (recipients: Recipient[]) => void
  rules: Rule[]
  digest: DigestSettings | null
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
        <div className="recipient-cards">
          {recipients.map((recipient) => (
            <RecipientCard
              key={recipient.id}
              recipient={recipient}
              rules={rules}
              digest={digest}
              editing={editingId === recipient.id}
              pausing={pausingId === recipient.id}
              deleting={deletingId === recipient.id}
              onPause={() => handlePause(recipient)}
              onDelete={() => handleDelete(recipient)}
              onEdit={() => onEdit(recipient)}
              onSaved={changed}
            />
          ))}
          {recipients.length === 0 && <p>Nenhum destinatário cadastrado ainda.</p>}
        </div>
      )}
    </section>
  )
}
