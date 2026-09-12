import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import {
  createRecipient,
  deleteRecipient,
  listRecipients,
  pauseRecipient,
  updateRecipient,
} from '../api/recipients'
import type { RecipientInput } from '../api/recipients'
import { ApiError } from '../api/auth'
import type { Recipient } from '../api/types'
import { StatusToggle } from '../components/StatusToggle'
import { useFillOrigin } from '../utils/useFillOrigin'
import '../components/GlassCard.css'
import '../components/CrudTable.css'
import '../components/FillButton.css'

interface RecipientForm {
  name: string
  telegramChatId: string
  allowlisted: boolean
}

const EMPTY_FORM: RecipientForm = { name: '', telegramChatId: '', allowlisted: true }

function recipientToForm(recipient: Recipient): RecipientForm {
  return {
    name: recipient.name,
    telegramChatId: recipient.telegram_chat_id,
    allowlisted: recipient.allowlisted,
  }
}

function formToInput(form: RecipientForm): RecipientInput {
  return { name: form.name, telegram_chat_id: form.telegramChatId, allowlisted: form.allowlisted }
}

type FormTarget = { kind: 'create' } | { kind: 'edit'; recipient: Recipient }

/**
 * No nav tab exists for "Destinatários" — docs/SPRINT4_DIRECTION.md fixes the
 * capsule at exactly 6 pages (Login, Feed, Regras, Fontes, Histórico, Saúde).
 * Recipient management lives here, on the Regras page, since that's where
 * alert routing is actually configured.
 */
export function DestinatariosSection() {
  const { csrfToken } = useAuth()
  const fillOrigin = useFillOrigin()
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [formTarget, setFormTarget] = useState<FormTarget | null>(null)
  const [form, setForm] = useState<RecipientForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pausingId, setPausingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const reload = () => {
    setLoading(true)
    listRecipients(true)
      .then((data) => {
        setRecipients(data)
        setListError(null)
      })
      .catch(() => setListError('Não foi possível carregar os destinatários.'))
      .finally(() => setLoading(false))
  }

  useEffect(reload, [])

  const openCreate = () => {
    setFormTarget({ kind: 'create' })
    setForm(EMPTY_FORM)
    setFormError(null)
  }

  const openEdit = (recipient: Recipient) => {
    setFormTarget({ kind: 'edit', recipient })
    setForm(recipientToForm(recipient))
    setFormError(null)
  }

  const closeForm = () => {
    setFormTarget(null)
    setFormError(null)
  }

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (formTarget === null) return
    if (csrfToken === null) {
      setFormError(CSRF_MISSING_MESSAGE)
      return
    }
    setSubmitting(true)
    setFormError(null)
    const input = formToInput(form)
    const request =
      formTarget.kind === 'create'
        ? createRecipient(csrfToken, input)
        : updateRecipient(csrfToken, formTarget.recipient.id, input)

    request
      .then(() => {
        closeForm()
        reload()
      })
      .catch((error: unknown) => {
        setFormError(
          error instanceof ApiError ? error.message : 'Não foi possível salvar o destinatário.',
        )
      })
      .finally(() => setSubmitting(false))
  }

  const handlePause = (recipient: Recipient) => {
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    setPausingId(recipient.id)
    pauseRecipient(csrfToken, recipient.id)
      .then(reload)
      .catch(() => setListError('Não foi possível pausar o destinatário.'))
      .finally(() => setPausingId(null))
  }

  const handleDelete = (recipient: Recipient) => {
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    setDeletingId(recipient.id)
    deleteRecipient(csrfToken, recipient.id)
      .then(reload)
      .catch((error: unknown) => {
        setListError(error instanceof ApiError ? error.message : 'Não foi possível excluir o destinatário.')
      })
      .finally(() => setDeletingId(null))
  }

  return (
    <section className="crud-page__section">
      <div className="crud-page__header">
        <h2>Destinatários</h2>
        <button
          type="button"
          className="crud-page__new-button fill-button"
          onClick={openCreate}
          onPointerDown={fillOrigin}
        >
          + Novo destinatário
        </button>
      </div>

      {formTarget && (
        <form className="glass-card crud-form" onSubmit={submitForm}>
          <h2>{formTarget.kind === 'create' ? 'Novo destinatário' : 'Editar destinatário'}</h2>
          <div className="crud-form__grid">
            <label>
              Nome
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
              />
            </label>
            <label>
              Chat ID do Telegram
              <input
                value={form.telegramChatId}
                onChange={(event) => setForm({ ...form, telegramChatId: event.target.value })}
                required
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.allowlisted}
                onChange={(event) => setForm({ ...form, allowlisted: event.target.checked })}
              />{' '}
              Autorizado a receber alertas
            </label>
          </div>
          <div className="crud-form__actions">
            <button
              type="submit"
              className="crud-form__submit fill-button"
              disabled={submitting}
              onPointerDown={fillOrigin}
            >
              {submitting ? 'Salvando…' : 'Salvar'}
            </button>
            <button type="button" className="crud-form__cancel" onClick={closeForm}>
              Cancelar
            </button>
          </div>
          {formError && (
            <p role="alert" className="crud-form__error">
              {formError}
            </p>
          )}
        </form>
      )}

      {loading && <p>Carregando…</p>}
      {listError && (
        <p role="alert" className="crud-page__error">
          {listError}
        </p>
      )}

      {!loading && !listError && (
        <div className="glass-card crud-table-wrap">
          <table className="crud-table">
            <thead>
              <tr>
                <th>Destinatário</th>
                <th>Chat ID</th>
                <th>Autorizado</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((recipient) => (
                <tr key={recipient.id}>
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
                  <td className="crud-table__actions" data-label="Ações">
                    <button type="button" onClick={() => openEdit(recipient)}>
                      Editar
                    </button>
                    <button
                      type="button"
                      className="crud-table__actions--danger"
                      onClick={() => handleDelete(recipient)}
                      disabled={deletingId === recipient.id}
                    >
                      Excluir
                    </button>
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
