import { useCallback, useEffect, useMemo, useState } from 'react'
import { CSRF_MISSING_MESSAGE } from '../auth/AuthContext'
import { fetchGroups, refreshGroups, selectGroups } from '../api/setup'
import type { Groups } from '../api/setup'
import { useFillOrigin } from '../utils/useFillOrigin'
import { errorMessage } from './timers'
import type { StepProps } from './types'

const POLL_MS = 2000
const FILTER_FROM = 8

const IN_PROGRESS = new Set(['pending', 'running', 'waiting_listener'])

/** Step 4: pick the groups to watch from the ones the account already reads. */
export function GroupsStep({ status, csrfToken, onRefresh }: StepProps) {
  const fillOrigin = useFillOrigin()
  const [groups, setGroups] = useState<Groups | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const ready = status.configured

  const load = useCallback(() => {
    fetchGroups()
      .then((next) => {
        setGroups(next)
        setError(null)
      })
      .catch((failure: unknown) => setError(errorMessage(failure, 'Não foi possível carregar a lista de grupos.')))
  }, [])

  useEffect(() => {
    if (ready) load()
  }, [ready, load])

  const inProgress = groups !== null && IN_PROGRESS.has(groups.state)
  useEffect(() => {
    if (!inProgress) return
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [inProgress, load])

  const visible = useMemo(() => {
    const dialogs = groups?.dialogs ?? []
    const needle = filter.trim().toLowerCase()
    return needle === '' ? dialogs : dialogs.filter((dialog) => dialog.title.toLowerCase().includes(needle))
  }, [groups, filter])

  if (!ready) {
    return (
      <p className="setup-note">
        Termine as credenciais, o login da conta e o bot (passos 1 a 3): o monitor só começa a ler depois
        disso, e é ele quem lista os seus grupos.
      </p>
    )
  }

  const search = () => {
    if (csrfToken === null) {
      setError(CSRF_MISSING_MESSAGE)
      return
    }
    setError(null)
    setNotice(null)
    refreshGroups(csrfToken)
      .then(setGroups)
      .catch((failure: unknown) => setError(errorMessage(failure, 'Não foi possível buscar os grupos.')))
  }

  const toggle = (chatId: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(chatId)) next.delete(chatId)
      else next.add(chatId)
      return next
    })

  const save = () => {
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
            : 'Esses grupos já estavam sendo monitorados.',
        )
        load()
        onRefresh()
      })
      .catch((failure: unknown) => setError(errorMessage(failure, 'Não foi possível salvar os grupos.')))
      .finally(() => setBusy(false))
  }

  const state = groups?.state ?? 'idle'
  return (
    <div className="setup-stack">
      <p className="setup-note">
        O teleyes <strong>só lê</strong>: ele nunca entra em grupos, responde, reage nem encaminha mensagens.
        A lista abaixo mostra os grupos e canais que a conta conectada já acessa.
      </p>

      {state === 'waiting_listener' && (
        <p className="setup-waiting" role="status">
          <span className="setup-spinner" aria-hidden="true" />O monitor ainda está iniciando. Isso leva
          alguns segundos depois de configurar o Telegram.
        </p>
      )}
      {(state === 'pending' || state === 'running') && (
        <p className="setup-waiting" role="status">
          <span className="setup-spinner" aria-hidden="true" />
          Buscando os grupos da conta…
        </p>
      )}
      {state === 'failed' && (
        <p role="alert" className="setup-error">
          Não foi possível listar os grupos{groups?.error ? ` (${groups.error})` : ''}. Confira se o monitor
          está conectado (página Saúde) e tente de novo.
        </p>
      )}

      {state === 'done' && groups !== null && groups.dialogs.length === 0 && (
        <p className="setup-note">Nenhum grupo ou canal encontrado nessa conta.</p>
      )}

      {state === 'done' && groups !== null && groups.dialogs.length > 0 && (
        <>
          {groups.dialogs.length >= FILTER_FROM && (
            <label className="setup-field">
              Filtrar
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Nome do grupo" />
            </label>
          )}
          <ul className="setup-groups" aria-label="Grupos e canais da conta">
            {visible.map((dialog) => {
              const checked = dialog.monitored || selected.has(dialog.chat_id)
              return (
                <li key={dialog.chat_id}>
                  <label className="setup-group">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={dialog.monitored}
                      onChange={() => toggle(dialog.chat_id)}
                    />
                    <span className="setup-group__title">{dialog.title}</span>
                    <span className="setup-group__meta">
                      {dialog.monitored ? 'já monitorado' : dialog.kind === 'channel' ? 'canal' : 'grupo'}
                    </span>
                  </label>
                </li>
              )
            })}
            {visible.length === 0 && <li className="setup-hint">Nenhum grupo com esse nome.</li>}
          </ul>
        </>
      )}

      {notice !== null && (
        <p role="status" className="setup-ok">
          {notice}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
      <div className="setup-actions">
        {state === 'done' && selected.size > 0 && (
          <button
            type="button"
            className="plane-action fill-button setup-button"
            onPointerDown={fillOrigin}
            onClick={save}
            disabled={busy}
          >
            {busy ? 'Salvando…' : `Monitorar ${selected.size} selecionado(s)`}
          </button>
        )}
        <button
          type="button"
          className={`plane-action setup-button${state === 'idle' ? ' fill-button' : ' plane-action--secondary'}`}
          onPointerDown={state === 'idle' ? fillOrigin : undefined}
          onClick={search}
          disabled={inProgress}
        >
          {state === 'idle' ? 'Buscar meus grupos' : 'Atualizar a lista'}
        </button>
      </div>
    </div>
  )
}
