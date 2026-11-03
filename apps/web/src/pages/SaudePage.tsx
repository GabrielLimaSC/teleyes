import { useCallback, useEffect, useRef, useState } from 'react'
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
import { fetchHealthEvents, fetchHealthHistory } from '../api/healthHistory'
import type { HealthHistory, ServiceKey, SystemEvent } from '../api/healthHistory'
import type { AdapterState, HealthResponse } from '../api/health'
import type { ListenerStatus } from '../api/listener'
import type { Recipient } from '../api/types'
import { describeLoaded, describeListener } from '../components/listenerState'
import { formatClockMoment } from '../utils/dates'
import { useFillOrigin } from '../utils/useFillOrigin'
import { SetupBanner, SetupReopenLink } from '../components/SetupBanner'
import { CollectorCard, EventsCard, ServiceCard, TelegramPreview, UpdatedAgo, VerdictStrip } from './SaudeParts'
import type { CollectorKpi } from './SaudeParts'
import { SERVICE_ORDER, buildVerdict, formatUptime } from './saudeModel'
import type { ServiceView, Tone } from './saudeModel'
import '../styles/materials.css'
import '../components/FillButton.css'
import './SaudePage.css'

const REFRESH_MS = 60_000

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
      Sem <code>TG_API_ID</code> / <code>TG_API_HASH</code>
    </>
  ),
  connecting: 'Abrindo a sessão de leitura',
  connected: 'Sessão de leitura ativa',
  reconnecting: 'Tentando reconectar',
  blocked: 'Bloqueado ou sem conexão após as tentativas',
  demo: 'Sem Telegram: os dados são fictícios',
}

function telegramView(state: AdapterState): Pick<ServiceView, 'pill' | 'tone'> {
  switch (state) {
    case 'connected':
      return { pill: 'ativo', tone: 'good' }
    case 'connecting':
    case 'reconnecting':
      return { pill: 'reconectando', tone: 'warn' }
    case 'blocked':
      return { pill: 'fora', tone: 'danger' }
    default:
      return { pill: 'desligado', tone: 'neutral' }
  }
}

function botView(state: HealthResponse['bot']['state']): Pick<ServiceView, 'pill' | 'tone'> {
  return state === 'configured' ? { pill: 'ativo', tone: 'good' } : { pill: 'desligado', tone: 'neutral' }
}

function listenerView(status: ListenerStatus | null): Pick<ServiceView, 'pill' | 'tone'> | null {
  if (status === null) return null
  const view = describeListener(status)
  if (view.failed) return { pill: 'falha', tone: 'warn' }
  if (view.busy) return { pill: view.shortLabel.replace('…', ''), tone: 'warn' }
  // Never heard from yet (fresh install): not "fora", just nothing to report.
  if (!status.listener_online) return { pill: 'sem sinal', tone: status.listener_seen_at === null ? 'neutral' : 'danger' }
  return { pill: 'ativo', tone: 'good' }
}

function sseView(state: SseState): Pick<ServiceView, 'pill' | 'tone'> {
  if (state === 'open') return { pill: 'ativo', tone: 'good' }
  if (state === 'connecting') return { pill: 'conectando', tone: 'warn' }
  return { pill: 'fora', tone: 'danger' }
}

function listenerDetail(status: ListenerStatus): ReactNode {
  const view = describeListener(status)
  const loaded = describeLoaded(status)
  if (status.state === 'idle' && !status.has_unapplied_changes && status.listener_online && loaded !== null) {
    return loaded
  }
  return (
    <>
      {view.detail}
      {view.needsApply && !view.busy && !view.failed && <> Aplique na página Regras.</>}
    </>
  )
}

/** `null` while unknown or failed to load: shown as "—", never a made-up 0. */
function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('pt-BR')
}

/**
 * Heartbeat history, collector series and event log. Refetched every minute
 * and on demand; a request that is still in flight is never doubled, and a
 * failed refresh keeps the last good data on screen.
 */
function useSaudeHistory() {
  const [history, setHistory] = useState<HealthHistory | null>(null)
  const [events, setEvents] = useState<SystemEvent[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const inFlight = useRef(false)

  const refresh = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    Promise.allSettled([fetchHealthHistory(24), fetchHealthEvents(20)])
      .then(([historyResult, eventsResult]) => {
        if (historyResult.status === 'fulfilled') setHistory(historyResult.value)
        if (eventsResult.status === 'fulfilled') setEvents(eventsResult.value)
        setFailed(historyResult.status === 'rejected' || eventsResult.status === 'rejected')
        if (historyResult.status === 'fulfilled' || eventsResult.status === 'fulfilled') {
          setUpdatedAt(Date.now())
        }
      })
      .finally(() => {
        inFlight.current = false
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { history, events, failed, loading, updatedAt, refresh }
}

export function SaudePage() {
  const { csrfToken } = useAuth()
  const { health, loading, error, sseState, refresh: refreshHealth } = useHealth()
  const fillOrigin = useFillOrigin()
  const listener = useListenerStatus()
  const saude = useSaudeHistory()

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
    // Only what existing endpoints really return. There is no "mensagens
    // lidas" number: the `vista` metric counts persisted matches per
    // (message, rule) pair, not messages.
    fetchSources()
      .then((sources) => setActiveSources(sources.filter((source) => source.active).length))
      .catch(() => setActiveSources(null))
    // S14-07: `grouped_match_ids` is every match id a card stands for, so
    // summing its length gives the real total regardless of duplicate grouping.
    fetchMatches()
      .then((matches) =>
        setMatchCount(matches.reduce((sum, match) => sum + (match.grouped_match_ids?.length ?? 1), 0)),
      )
      .catch(() => setMatchCount(null))
  }, [])

  const reverify = () => {
    refreshHealth()
    listener.refresh()
    saude.refresh()
  }

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
        saude.refresh()
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

  const views = buildViews(health, listener.status, sseState)
  const verdict = health ? buildVerdict(views, health.demo === true) : null
  const bucketsOf = (key: ServiceKey) =>
    saude.history?.services.find((service) => service.service === key)?.buckets ?? []

  const detail = (key: ServiceKey): ReactNode => {
    if (health === null) return ''
    switch (key) {
      case 'telegram':
        return TELEGRAM_DETAILS[health.telegram.state]
      case 'bot':
        return health.bot.state === 'configured' ? (
          'Alertas saem por este bot'
        ) : health.bot.state === 'demo' ? (
          'Sem bot: nenhum alerta sai da demonstração'
        ) : (
          <>
            Sem <code>BOT_TOKEN</code>: nenhum alerta sai
          </>
        )
      case 'listener':
        return listener.status ? listenerDetail(listener.status) : 'Lendo o estado do listener…'
      case 'sse':
        return SSE_DETAILS[sseState]
      case 'db':
        return 'SQLite respondendo'
    }
  }

  const lastReconnect = saude.events?.find((event) => event.kind === 'listener_reconnect')
  const totals = saude.history?.collector.totals
  const kpis: CollectorKpi[] = [
    { label: 'Matches gerados', value: formatCount(matchCount) },
    { label: 'Fontes ativas', value: formatCount(activeSources) },
  ]
  if (totals) {
    kpis.push({ label: 'Descartadas · 24h', value: formatCount(totals.discarded) })
    kpis.push({ label: 'Erros · 1h', value: formatCount(totals.delivery_failures_last_hour) })
  }
  if (lastReconnect) {
    kpis.push({ label: 'Última reconexão', value: formatClockMoment(lastReconnect.at).replace(/^às /, '') })
  }

  return (
    <main className="saude-page">
      <div className="saude-page__header">
        <div>
          <h1>Saúde</h1>
          <p className="saude-page__subtitle">
            Estado dos serviços e teste de entrega · <UpdatedAgo at={saude.updatedAt} />
          </p>
        </div>
        <button type="button" className="saude-reverify" onClick={reverify} disabled={saude.loading}>
          {saude.loading ? 'Verificando…' : 'Reverificar'}
        </button>
      </div>

      <SetupBanner />
      <SetupReopenLink />

      {loading && <p>Carregando…</p>}
      {error && (
        <p role="alert" className="saude-page__error">
          {error}
        </p>
      )}

      {health && verdict && (
        <>
          <VerdictStrip
            verdict={verdict}
            uptime={formatUptime(health.uptime_seconds)}
            env={health.env}
            version={health.version}
          />
          <div className="saude-tiles">
            {SERVICE_ORDER.map(({ key, name }) => {
              const view = views.find((candidate) => candidate.key === key) ?? {
                key,
                name,
                pill: '…',
                tone: 'neutral' as Tone,
              }
              return <ServiceCard key={key} view={view} detail={detail(key)} buckets={bucketsOf(key)} />
            })}
          </div>
        </>
      )}

      <div className="saude-page__grid">
        <CollectorCard collector={saude.history?.collector ?? null} kpis={kpis} />

        <section className="plane-pearl saude-panel">
          <div>
            <h2>Teste de notificação</h2>
            <p className="saude-panel__sub">
              {health?.demo === true ? (
                'Na demonstração nada sai de verdade: o envio é simulado.'
              ) : (
                <>
                  Aciona o envio real. Sem <code>BOT_TOKEN</code> retorna <code>not_configured</code>, sem
                  fingir entrega.
                </>
              )}
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
          <TelegramPreview text={text} />
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

      <EventsCard events={saude.events} failed={saude.failed} />
    </main>
  )
}

function buildViews(
  health: HealthResponse | null,
  listener: ListenerStatus | null,
  sseState: SseState,
): ServiceView[] {
  if (health === null) return []
  const name = (key: ServiceKey) => SERVICE_ORDER.find((service) => service.key === key)?.name ?? key
  const views: ServiceView[] = [
    { key: 'telegram', name: name('telegram'), ...telegramView(health.telegram.state) },
    { key: 'bot', name: name('bot'), ...botView(health.bot.state) },
  ]
  const listenerState = listenerView(listener)
  if (listenerState) views.push({ key: 'listener', name: name('listener'), ...listenerState })
  views.push({ key: 'sse', name: name('sse'), ...sseView(sseState) })
  // The API answered this very request, so the database is up.
  views.push({ key: 'db', name: name('db'), pill: 'ativo', tone: 'good' })
  return views
}
