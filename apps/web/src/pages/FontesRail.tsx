import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { CSRF_MISSING_MESSAGE } from '../auth/AuthContext'
import { ApiError } from '../api/auth'
import { fetchGroups, refreshGroups, selectGroups } from '../api/setup'
import type { Groups, SetupStatus } from '../api/setup'
import { createSource, updateSource } from '../api/sources'
import type { SourceInput } from '../api/sources'
import type { Source } from '../api/types'
import { useFillOrigin } from '../utils/useFillOrigin'
import '../components/FillButton.css'

export type RailTab = 'account' | 'chat'
export type FormTarget = { kind: 'create' } | { kind: 'edit'; source: Source }

const POLL_MS = 2000
const IN_PROGRESS = new Set(['pending', 'running', 'waiting_listener'])

interface SourceForm {
  name: string
  telegramChatId: string
}

function toInput(form: SourceForm): SourceInput {
  return { name: form.name, telegram_chat_id: form.telegramChatId }
}

function failure(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

interface RailProps {
  csrfToken: string | null
  /** null while loading or unavailable (demo): treated as "not configured". */
  setupStatus: SetupStatus | null
  sources: Source[]
  editTarget: Source | null
  /** Bumped by "+ Novo grupo": scrolls the rail into view and focuses its first field. */
  focusSignal: number
  onChanged: () => void
  onCancelEdit: () => void
  /** Phone: the rail lives in a BottomSheet (which has the title); called after a chat_id save. */
  embedded?: boolean
  onDone?: () => void
}

/** S21-11: "Adicionar grupo" rail — pick from the account's groups, or register by chat_id. */
export function FontesRail({ csrfToken, setupStatus, sources, editTarget, focusSignal, onChanged, onCancelEdit, embedded = false, onDone }: RailProps) {
  const configured = setupStatus?.configured === true
  const [chosenTab, setChosenTab] = useState<RailTab | null>(null)
  const tab: RailTab = editTarget !== null ? 'chat' : (chosenTab ?? (configured ? 'account' : 'chat'))
  const railRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (focusSignal === 0) return
    railRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    railRef.current?.querySelector<HTMLElement>('[data-rail-focus]')?.focus()
  }, [focusSignal])

  const selectTab = (next: RailTab) => {
    if (editTarget !== null) onCancelEdit()
    setChosenTab(next)
  }

  return (
    <aside
      className={embedded ? 'fontes-rail fontes-rail--embedded' : 'plane-glass fontes-rail'}
      aria-label="Adicionar grupo"
      ref={railRef}
      id="fontes-rail"
    >
      {!embedded && <h2 className="fontes-rail__eyebrow">{editTarget !== null ? 'Editar grupo' : 'Adicionar grupo'}</h2>}
      <div className="fontes-tabs" role="tablist" aria-label="Como adicionar">
        {(
          [
            ['account', 'Da minha conta'],
            ['chat', 'Por chat_id'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`fontes-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="fontes-tabpanel"
            className={`fontes-tabs__tab${tab === id ? ' fontes-tabs__tab--active' : ''}`}
            onClick={() => selectTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="fontes-tabpanel" aria-labelledby={`fontes-tab-${tab}`} className="fontes-rail__panel">
        {tab === 'account' ? (
          <AccountTab csrfToken={csrfToken} configured={configured} sources={sources} onAdded={onChanged} />
        ) : (
          <ChatIdForm
            key={editTarget === null ? 'create' : `edit-${editTarget.id}`}
            csrfToken={csrfToken}
            editTarget={editTarget}
            onSaved={() => {
              onChanged()
              onDone?.()
            }}
            onCancelEdit={onCancelEdit}
          />
        )}
      </div>
      {embedded && (
        <div className="fontes-rail__help">
          <details>
            <summary>Como adicionar</summary>
            <p>
              Na aba “Da minha conta” escolha um grupo que a conta já acessa; em “Por chat_id” informe o nome e o id do
              chat.
            </p>
          </details>
          <details>
            <summary>Não aparece na lista?</summary>
            <p>
              A conta precisa estar no grupo. Para canais privados, use “Por chat_id” — o id começa com <code>-100</code>.
            </p>
          </details>
        </div>
      )}
    </aside>
  )
}

function AccountTab({
  csrfToken,
  configured,
  sources,
  onAdded,
}: {
  csrfToken: string | null
  configured: boolean
  sources: Source[]
  onAdded: () => void
}) {
  const fillOrigin = useFillOrigin()
  const [groups, setGroups] = useState<Groups | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetchGroups()
      .then((next) => {
        setGroups(next)
        setError(null)
      })
      .catch((cause: unknown) => setError(failure(cause, 'Não foi possível carregar a lista de grupos.')))
  }, [])

  useEffect(() => {
    if (configured) load()
  }, [configured, load])

  const inProgress = groups !== null && IN_PROGRESS.has(groups.state)
  useEffect(() => {
    if (!inProgress) return
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [inProgress, load])

  const registered = useMemo(() => new Set(sources.map((source) => source.telegram_chat_id)), [sources])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const dialogs = groups?.dialogs ?? []
    return needle === '' ? dialogs : dialogs.filter((dialog) => dialog.title.toLowerCase().includes(needle))
  }, [groups, filter])

  if (!configured) {
    return (
      <div className="fontes-empty" role="status">
        <p className="fontes-empty__title">Telegram ainda não configurado</p>
        <p className="fontes-empty__text">
          Para listar os grupos que a sua conta já acessa, conecte a conta no{' '}
          <Link to="/configuracao">assistente de configuração</Link>. Enquanto isso, use “Por chat_id”.
        </p>
      </div>
    )
  }

  const toggle = (chatId: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(chatId)) next.delete(chatId)
      else next.add(chatId)
      return next
    })

  const refresh = () => {
    if (csrfToken === null) {
      setError(CSRF_MISSING_MESSAGE)
      return
    }
    setError(null)
    setNotice(null)
    refreshGroups(csrfToken)
      .then(setGroups)
      .catch((cause: unknown) => setError(failure(cause, 'Não foi possível atualizar a lista.')))
  }

  const add = () => {
    if (csrfToken === null) {
      setError(CSRF_MISSING_MESSAGE)
      return
    }
    setBusy(true)
    setError(null)
    selectGroups(csrfToken, [...selected])
      .then((result) => {
        setSelected(new Set())
        setNotice(
          result.created > 0
            ? `${result.created} grupo(s) adicionado(s). O monitor aplica a mudança em alguns segundos.`
            : 'Esses grupos já estavam cadastrados.',
        )
        load()
        onAdded()
      })
      .catch((cause: unknown) => setError(failure(cause, 'Não foi possível adicionar os grupos.')))
      .finally(() => setBusy(false))
  }

  const state = groups?.state ?? 'idle'
  const count = selected.size
  return (
    <div className="fontes-account">
      <input
        type="search"
        className="fontes-search"
        placeholder="Buscar grupo…"
        aria-label="Buscar grupo"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        data-rail-focus
      />

      {inProgress && (
        <p className="fontes-note" role="status">
          {state === 'waiting_listener'
            ? 'O monitor ainda está iniciando. Isso leva alguns segundos.'
            : 'Buscando os grupos da conta…'}
        </p>
      )}
      {state === 'failed' && (
        <p role="alert" className="fontes-error">
          Não foi possível listar os grupos{groups?.error ? ` (${groups.error})` : ''}. Confira se o monitor está
          conectado (página Saúde) e tente de novo.
        </p>
      )}
      {state === 'idle' && <p className="fontes-note">Ainda não buscamos os grupos desta conta.</p>}
      {state === 'done' && groups !== null && groups.dialogs.length === 0 && (
        <p className="fontes-note">Nenhum grupo ou canal encontrado nessa conta.</p>
      )}

      {groups !== null && groups.dialogs.length > 0 && (
        <ul className="fontes-groups" aria-label="Grupos e canais da conta">
          {visible.map((dialog) => {
            const already = dialog.monitored || registered.has(dialog.chat_id)
            const checked = already || selected.has(dialog.chat_id)
            return (
              <li key={dialog.chat_id}>
                <label className={`fontes-group${already ? ' fontes-group--disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={already}
                    onChange={() => toggle(dialog.chat_id)}
                  />
                  <span className="fontes-group__text">
                    <span className="fontes-group__title">{dialog.title}</span>
                    <span className="fontes-group__meta">
                      {already ? 'já cadastrada' : dialog.kind === 'channel' ? 'canal' : 'grupo'}
                    </span>
                  </span>
                </label>
              </li>
            )
          })}
          {visible.length === 0 && <li className="fontes-note">Nenhum grupo com esse nome.</li>}
        </ul>
      )}

      {notice !== null && (
        <p role="status" className="fontes-ok">
          {notice}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="fontes-error">
          {error}
        </p>
      )}

      <button
        type="button"
        className="plane-action fill-button fontes-rail__primary"
        onPointerDown={fillOrigin}
        onClick={add}
        disabled={count === 0 || busy}
      >
        {busy ? 'Adicionando…' : count === 0 ? 'Adicionar grupos' : `Adicionar ${count} ${count === 1 ? 'grupo' : 'grupos'}`}
      </button>
      <button
        type="button"
        className="plane-action plane-action--secondary fontes-rail__secondary"
        onClick={refresh}
        disabled={inProgress}
      >
        Atualizar lista
      </button>
    </div>
  )
}

function ChatIdForm({
  csrfToken,
  editTarget,
  onSaved,
  onCancelEdit,
}: {
  csrfToken: string | null
  editTarget: Source | null
  onSaved: () => void
  onCancelEdit: () => void
}) {
  const fillOrigin = useFillOrigin()
  const [form, setForm] = useState<SourceForm>(
    editTarget === null ? { name: '', telegramChatId: '' } : { name: editTarget.name, telegramChatId: editTarget.telegram_chat_id },
  )
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (csrfToken === null) {
      setError(CSRF_MISSING_MESSAGE)
      return
    }
    setSubmitting(true)
    setError(null)
    const input = toInput(form)
    const request = editTarget === null ? createSource(csrfToken, input) : updateSource(csrfToken, editTarget.id, input)
    request
      .then(() => {
        setForm({ name: '', telegramChatId: '' })
        if (editTarget !== null) onCancelEdit()
        onSaved()
      })
      .catch((cause: unknown) => setError(failure(cause, 'Não foi possível salvar o grupo.')))
      .finally(() => setSubmitting(false))
  }

  return (
    <form className="fontes-form" onSubmit={submit}>
      <label className="fontes-form__field">
        Nome
        <input
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          required
          data-rail-focus
        />
      </label>
      <label className="fontes-form__field">
        Chat ID do Telegram
        <input
          value={form.telegramChatId}
          onChange={(event) => setForm({ ...form, telegramChatId: event.target.value })}
          placeholder="-100…"
          inputMode="numeric"
          required
        />
      </label>
      <p className="fontes-note">O id começa com -100.</p>
      <button type="submit" className="plane-action fill-button fontes-rail__primary" disabled={submitting} onPointerDown={fillOrigin}>
        {submitting ? 'Salvando…' : 'Salvar'}
      </button>
      {editTarget !== null && (
        <button type="button" className="plane-action plane-action--secondary fontes-rail__secondary" onClick={onCancelEdit}>
          Cancelar
        </button>
      )}
      {error !== null && (
        <p role="alert" className="fontes-error">
          {error}
        </p>
      )}
    </form>
  )
}
