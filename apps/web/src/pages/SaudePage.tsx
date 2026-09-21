import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth, CSRF_MISSING_MESSAGE } from '../auth/AuthContext'
import { useHealth } from '../hooks/useHealth'
import { useListenerStatus } from '../hooks/useListenerStatus'
import type { SseState } from '../hooks/useHealth'
import { listRecipients } from '../api/recipients'
import { fetchSources } from '../api/lookups'
import { fetchMatches } from '../api/matches'
import { testNotification } from '../api/notifications'
import { ApiError } from '../api/auth'
import type { AdapterState } from '../api/health'
import type { ListenerStatus } from '../api/listener'
import type { Recipient } from '../api/types'
import { botStateLabel, telegramStateLabel } from '../components/adapterStateLabel'
import type { StateLabel } from '../components/adapterStateLabel'
import { describeLoaded, describeListener } from '../components/listenerState'
import { useFillOrigin } from '../utils/useFillOrigin'
import '../styles/materials.css'
import '../components/FillButton.css'
import './SaudePage.css'

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (hours > 0) return `${hours}h ${minutes}min`
  if (minutes > 0) return `${minutes}min ${secs}s`
  return `${secs}s`
}

const SSE_STATE_LABELS: Record<SseState, StateLabel> = {
  connecting: { label: 'Conectando…', color: 'var(--state-warn-text)', dot: 'var(--state-warn-dot)' },
  open: { label: 'Conectado', color: 'var(--state-good-text)', dot: 'var(--state-good-dot)' },
  error: { label: 'Desconectado', color: 'var(--state-danger-text)', dot: 'var(--state-danger-dot)' },
}

// Only what each state really means (`packages/telegram/adapter.py`,
// `useHealth.ts`) — no attempt counters or timings the app never tracks.
const SSE_DETAILS: Record<SseState, string> = {
  connecting: 'Abrindo a conexão de eventos',
  open: 'Eventos chegando ao vivo',
  error: 'A conexão caiu; o navegador tenta reconectar sozinho',
}

const TELEGRAM_DETAILS: Record<AdapterState, ReactNode> = {
  not_configured: (
    <>
      Falta <code>TG_API_ID</code> / <code>TG_API_HASH</code>
    </>
  ),
  connecting: 'Abrindo a sessão de leitura',
  connected: 'Sessão de leitura ativa',
  reconnecting: 'Tentando reconectar',
  blocked: 'Bloqueado ou sem conexão após as tentativas',
}

function StatusTile({ label, state, detail }: { label: string; state: StateLabel; detail: ReactNode }) {
  return (
    <div className="plane-pearl saude-tile">
      <div className="saude-tile__label">{label}</div>
      <div className="saude-tile__state">
        <span className="saude-tile__dot" style={{ background: state.dot }} />
        <span>{state.label}</span>
      </div>
      <div className="saude-tile__detail">{detail}</div>
    </div>
  )
}

/**
 * S13-06: what the listener process is running with. The button that applies
 * changes lives on Regras; here Gabriel only sees the state and is pointed there.
 */
function ListenerTile({ status }: { status: ListenerStatus }) {
  const view = describeListener(status)
  const loaded = describeLoaded(status)
  return (
    <StatusTile
      label="Listener"
      state={{ ...view, label: view.shortLabel }}
      detail={
        <>
          {view.detail}
          {loaded !== null && status.state === 'idle' && !status.has_unapplied_changes && (
            <> {loaded}.</>
          )}
          {view.needsApply && !view.busy && !view.failed && <> Aplique na página Regras.</>}
        </>
      }
    />
  )
}

/** `null` while unknown or failed to load: shown as "—", never a made-up 0. */
function formatCount(value: number | null): string {
  return value === null ? '—' : String(value)
}

export function SaudePage() {
  const { csrfToken } = useAuth()
  const { health, loading, error, sseState } = useHealth()
  const fillOrigin = useFillOrigin()
  const listener = useListenerStatus()

  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [recipientId, setRecipientId] = useState('')
  const [text, setText] = useState('Teste de notificação do teleyes.')
  const [sending, setSending] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  const [activeSources, setActiveSources] = useState<number | null>(null)
  const [matchCount, setMatchCount] = useState<number | null>(null)

  useEffect(() => {
    listRecipients().then(setRecipients).catch(() => setRecipients([]))
    // S11-06: only what existing endpoints really return. There is no
    // "mensagens lidas" number: the `vista` metric counts persisted matches
    // per (message, rule) pair, not messages, so it stays out until a real
    // per-message counter exists (Fase 2).
    fetchSources()
      .then((sources) => setActiveSources(sources.filter((source) => source.active).length))
      .catch(() => setActiveSources(null))
    fetchMatches()
      .then((matches) => setMatchCount(matches.length))
      .catch(() => setMatchCount(null))
  }, [])

  const sendTest = () => {
    const recipient = recipients.find((candidate) => String(candidate.id) === recipientId)
    if (recipient === undefined) return
    if (csrfToken === null) {
      setTestError(CSRF_MISSING_MESSAGE)
      return
    }
    setSending(true)
    setTestError(null)
    setTestResult(null)
    testNotification(csrfToken, recipient.telegram_chat_id, text)
      .then((result) => {
        setTestResult(
          result.delivered ? 'Entregue com sucesso.' : `Não entregue — status: ${result.status}.`,
        )
      })
      .catch((err: unknown) => {
        setTestError(err instanceof ApiError ? err.message : 'Não foi possível testar a notificação.')
      })
      .finally(() => setSending(false))
  }

  // What blocks or shapes the send button, from the real state only.
  const testHint =
    recipientId === ''
      ? 'Selecione um destinatário para habilitar o envio.'
      : health?.bot.state === 'not_configured'
        ? 'O bot está sem token: o envio volta como not_configured, sem fingir entrega.'
        : null

  return (
    <main className="saude-page">
      <div className="saude-page__header">
        <h1>Saúde</h1>
        <p className="saude-page__subtitle">Estado dos serviços e teste de entrega.</p>
      </div>

      {loading && <p>Carregando…</p>}
      {error && (
        <p role="alert" className="saude-page__error">
          {error}
        </p>
      )}

      {health && (
        <div className="saude-tiles">
          <StatusTile
            label="Telegram"
            state={telegramStateLabel(health.telegram.state)}
            detail={TELEGRAM_DETAILS[health.telegram.state]}
          />
          <StatusTile
            label="Bot"
            state={botStateLabel(health.bot.state)}
            detail={
              health.bot.state === 'configured' ? (
                'Alertas saem por este bot'
              ) : (
                <>
                  Sem <code>BOT_TOKEN</code>, nada é enviado
                </>
              )
            }
          />
          {listener.status && <ListenerTile status={listener.status} />}
          <StatusTile
            label="Feed em tempo real (SSE)"
            state={SSE_STATE_LABELS[sseState]}
            detail={SSE_DETAILS[sseState]}
          />
          <StatusTile
            label="Ambiente"
            state={{
              label: health.env,
              color: 'var(--plane-status-good)',
              dot: 'var(--plane-status-good-dot)',
            }}
            detail={`v${health.version} · tempo ativo ${formatUptime(health.uptime_seconds)}`}
          />
        </div>
      )}

      <div className="saude-page__grid">
        <section className="plane-pearl saude-panel">
          <div>
            <h2>Resumo do coletor</h2>
            <p className="saude-panel__sub">Contagens de agora — não são do dia.</p>
          </div>
          <dl className="saude-stats">
            <div className="saude-stats__item">
              <dt>Fontes ativas</dt>
              <dd>{formatCount(activeSources)}</dd>
            </div>
            <div className="saude-stats__item">
              <dt>Matches gerados</dt>
              <dd>{formatCount(matchCount)}</dd>
            </div>
          </dl>
        </section>

        <section className="plane-pearl saude-panel">
          <div>
            <h2>Teste de notificação</h2>
            <p className="saude-panel__sub">
              Aciona o envio real. Sem <code>BOT_TOKEN</code> retorna <code>not_configured</code>, sem
              fingir entrega.
            </p>
          </div>
          <label className="saude-panel__field">
            Destinatário
            <select value={recipientId} onChange={(event) => setRecipientId(event.target.value)}>
              <option value="">Selecione…</option>
              {recipients.map((recipient) => (
                <option key={recipient.id} value={recipient.id}>
                  {recipient.name}
                </option>
              ))}
            </select>
          </label>
          <label className="saude-panel__field">
            Mensagem
            <input value={text} onChange={(event) => setText(event.target.value)} />
          </label>
          <button
            type="button"
            className="plane-action fill-button saude-panel__send"
            onClick={sendTest}
            onPointerDown={fillOrigin}
            disabled={sending || recipientId === ''}
          >
            {sending ? 'Enviando…' : 'Enviar teste'}
          </button>
          {testHint && <p className="saude-panel__hint">{testHint}</p>}
          {testResult && <p className="saude-page__result">{testResult}</p>}
          {testError && (
            <p role="alert" className="saude-page__error">
              {testError}
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
