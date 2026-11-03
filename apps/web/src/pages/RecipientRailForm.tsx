import { useState } from 'react'
import type { FormEvent } from 'react'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import { createRecipient, updateRecipient } from '../api/recipients'
import type { RecipientInput } from '../api/recipients'
import { ApiError } from '../api/auth'
import type { Recipient } from '../api/types'
import { useFillOrigin } from '../utils/useFillOrigin'
import '../components/FillButton.css'
import './RegrasPage.css'

export type RecipientFormTarget = { kind: 'create' } | { kind: 'edit'; recipient: Recipient }

interface RecipientForm {
  name: string
  telegramChatId: string
  allowlisted: boolean
}

function initialForm(target: RecipientFormTarget): RecipientForm {
  if (target.kind === 'create') return { name: '', telegramChatId: '', allowlisted: true }
  return {
    name: target.recipient.name,
    telegramChatId: target.recipient.telegram_chat_id,
    allowlisted: target.recipient.allowlisted,
  }
}

/**
 * S21-02: the recipient form, moved to the Regras page's contextual right rail.
 * It only replaces the rule form while a recipient is being created or edited
 * ("+ Adicionar destinatário" / "Editar"); "Cancelar" hands the rail back.
 * Remount it (`key`) per target so a half-typed value never leaks across.
 */
export function RecipientRailForm({
  target,
  onSaved,
  onCancel,
}: {
  target: RecipientFormTarget
  onSaved: () => void
  onCancel: () => void
}) {
  const { csrfToken } = useAuth()
  const fillOrigin = useFillOrigin()
  const [form, setForm] = useState<RecipientForm>(() => initialForm(target))
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (csrfToken === null) {
      setFormError(CSRF_MISSING_MESSAGE)
      return
    }
    setSubmitting(true)
    setFormError(null)
    const input: RecipientInput = {
      name: form.name,
      telegram_chat_id: form.telegramChatId,
      allowlisted: form.allowlisted,
    }
    const request =
      target.kind === 'create'
        ? createRecipient(csrfToken, input)
        : updateRecipient(csrfToken, target.recipient.id, input)
    request
      .then(onSaved)
      .catch((error: unknown) => {
        setFormError(error instanceof ApiError ? error.message : 'Não foi possível salvar o destinatário.')
      })
      .finally(() => setSubmitting(false))
  }

  return (
    <form className="plane-glass regras-form" onSubmit={submit}>
      <h2 className="regras-rail__eyebrow">{target.kind === 'create' ? 'Novo destinatário' : 'Editar destinatário'}</h2>
      <label className="regras-form__field">
        Nome
        <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
      </label>
      <label className="regras-form__field">
        Chat ID do Telegram
        <input
          value={form.telegramChatId}
          onChange={(event) => setForm({ ...form, telegramChatId: event.target.value })}
          required
        />
      </label>
      <p className="regras-form__helper">A pessoa precisa ter iniciado conversa com o bot.</p>
      <label className="regras-form__check">
        <input
          type="checkbox"
          checked={form.allowlisted}
          onChange={(event) => setForm({ ...form, allowlisted: event.target.checked })}
        />{' '}
        Autorizado a receber alertas
      </label>
      <div className="regras-form__actions">
        <button
          type="submit"
          className="plane-action fill-button regras-form__submit"
          disabled={submitting}
          onPointerDown={fillOrigin}
        >
          {submitting ? 'Salvando…' : 'Salvar'}
        </button>
        <button type="button" className="plane-action plane-action--secondary regras-form__cancel" onClick={onCancel}>
          Cancelar
        </button>
      </div>
      {formError && (
        <p role="alert" className="regras-form__error">
          {formError}
        </p>
      )}
    </form>
  )
}
