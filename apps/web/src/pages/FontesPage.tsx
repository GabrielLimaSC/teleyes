import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import { createSource, deleteSource, listSources, pauseSource, updateSource } from '../api/sources'
import type { SourceInput } from '../api/sources'
import { fetchMatches } from '../api/matches'
import { ApiError } from '../api/auth'
import type { Source } from '../api/types'
import { StatusToggle } from '../components/StatusToggle'
import { useFillOrigin } from '../utils/useFillOrigin'
import '../components/GlassCard.css'
import '../components/CrudTable.css'
import '../components/FillButton.css'

interface SourceForm {
  name: string
  telegramChatId: string
}

const EMPTY_FORM: SourceForm = { name: '', telegramChatId: '' }

function sourceToForm(source: Source): SourceForm {
  return { name: source.name, telegramChatId: source.telegram_chat_id }
}

function formToInput(form: SourceForm): SourceInput {
  return { name: form.name, telegram_chat_id: form.telegramChatId }
}

function formatLastMatch(iso: string | undefined): string {
  if (iso === undefined) return 'Nenhum match ainda'
  return new Date(iso).toLocaleString('pt-BR')
}

type FormTarget = { kind: 'create' } | { kind: 'edit'; source: Source }

export function FontesPage() {
  const { csrfToken } = useAuth()
  const fillOrigin = useFillOrigin()
  const [sources, setSources] = useState<Source[]>([])
  const [lastMatchBySource, setLastMatchBySource] = useState<Map<number, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [formTarget, setFormTarget] = useState<FormTarget | null>(null)
  const [form, setForm] = useState<SourceForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pausingId, setPausingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const reload = () => {
    setLoading(true)
    Promise.all([listSources(true), fetchMatches()])
      .then(([sourcesData, matches]) => {
        setSources(sourcesData)
        // GET /sources/GET /matches have no "last event" field — this is derived
        // client-side from real match data, never invented.
        const lastMatch = new Map<number, string>()
        for (const match of matches) {
          const current = lastMatch.get(match.source_id)
          if (current === undefined || match.matched_at > current) {
            lastMatch.set(match.source_id, match.matched_at)
          }
        }
        setLastMatchBySource(lastMatch)
        setListError(null)
      })
      .catch(() => setListError('Não foi possível carregar as fontes.'))
      .finally(() => setLoading(false))
  }

  useEffect(reload, [])

  const openCreate = () => {
    setFormTarget({ kind: 'create' })
    setForm(EMPTY_FORM)
    setFormError(null)
  }

  const openEdit = (source: Source) => {
    setFormTarget({ kind: 'edit', source })
    setForm(sourceToForm(source))
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
        ? createSource(csrfToken, input)
        : updateSource(csrfToken, formTarget.source.id, input)

    request
      .then(() => {
        closeForm()
        reload()
      })
      .catch((error: unknown) => {
        setFormError(error instanceof ApiError ? error.message : 'Não foi possível salvar a fonte.')
      })
      .finally(() => setSubmitting(false))
  }

  const handlePause = (source: Source) => {
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    setPausingId(source.id)
    pauseSource(csrfToken, source.id)
      .then(reload)
      .catch(() => setListError('Não foi possível pausar a fonte.'))
      .finally(() => setPausingId(null))
  }

  const handleDelete = (source: Source) => {
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    setDeletingId(source.id)
    deleteSource(csrfToken, source.id)
      .then(reload)
      .catch((error: unknown) => {
        setListError(error instanceof ApiError ? error.message : 'Não foi possível excluir a fonte.')
      })
      .finally(() => setDeletingId(null))
  }

  return (
    <main className="crud-page">
      <div className="crud-page__header">
        <h1>Fontes</h1>
        <button
          type="button"
          className="crud-page__new-button fill-button"
          onClick={openCreate}
          onPointerDown={fillOrigin}
        >
          + Nova fonte
        </button>
      </div>
      <p style={{ marginTop: -12, marginBottom: 20, fontSize: 13, color: '#4b4b52' }}>
        Cadastro manual pelo chat_id do grupo — ainda não há um jeito de listar os grupos que a conta já
        acessa direto por aqui.
      </p>

      {formTarget && (
        <form className="glass-card crud-form" onSubmit={submitForm}>
          <h2>{formTarget.kind === 'create' ? 'Nova fonte' : 'Editar fonte'}</h2>
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
                <th>Fonte</th>
                <th>Chat ID</th>
                <th>Último match</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td className="crud-table__name">{source.name}</td>
                  <td>{source.telegram_chat_id}</td>
                  <td>{formatLastMatch(lastMatchBySource.get(source.id))}</td>
                  <td>
                    <StatusToggle
                      active={source.active}
                      pausing={pausingId === source.id}
                      onPause={() => handlePause(source)}
                    />
                  </td>
                  <td className="crud-table__actions">
                    <button type="button" onClick={() => openEdit(source)}>
                      Editar
                    </button>
                    <button
                      type="button"
                      className="crud-table__actions--danger"
                      onClick={() => handleDelete(source)}
                      disabled={deletingId === source.id}
                    >
                      Excluir
                    </button>
                  </td>
                </tr>
              ))}
              {sources.length === 0 && (
                <tr>
                  <td colSpan={5}>Nenhuma fonte cadastrada ainda.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
