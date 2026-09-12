import { useEffect, useState } from 'react'
import { useAuth, CSRF_MISSING_MESSAGE } from '../auth/AuthContext'
import { useHealth } from '../hooks/useHealth'
import type { SseState } from '../hooks/useHealth'
import { listRecipients } from '../api/recipients'
import { testNotification } from '../api/notifications'
import { ApiError } from '../api/auth'
import type { Recipient } from '../api/types'
import { botStateLabel, telegramStateLabel } from '../components/adapterStateLabel'
import { useFillOrigin } from '../utils/useFillOrigin'
import '../components/GlassCard.css'
import '../components/CrudTable.css'
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

const SSE_STATE_LABELS: Record<SseState, { label: string; color: string }> = {
  connecting: { label: 'Conectando…', color: '#8a6d00' },
  open: { label: 'Conectado', color: '#1c8a4b' },
  error: { label: 'Desconectado', color: '#b3261e' },
}

function StatusRow({ label, state }: { label: string; state: { label: string; color: string } }) {
  return (
    <div className="saude-row">
      <span className="saude-row__label">{label}</span>
      <span className="saude-row__value">
        <span className="saude-row__dot" style={{ background: state.color }} />
        {state.label}
      </span>
    </div>
  )
}

export function SaudePage() {
  const { csrfToken } = useAuth()
  const { health, loading, error, sseState } = useHealth()
  const fillOrigin = useFillOrigin()

  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [recipientId, setRecipientId] = useState('')
  const [text, setText] = useState('Teste de notificação do teleyes.')
  const [sending, setSending] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  useEffect(() => {
    listRecipients().then(setRecipients).catch(() => setRecipients([]))
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

  return (
    <main className="saude-page">
      <h1>Saúde</h1>

      {loading && <p>Carregando…</p>}
      {error && (
        <p role="alert" className="saude-page__error">
          {error}
        </p>
      )}

      {health && (
        <section className="glass-card saude-panel">
          <StatusRow label="Telegram" state={telegramStateLabel(health.telegram.state)} />
          <StatusRow label="Bot" state={botStateLabel(health.bot.state)} />
          <StatusRow label="Feed em tempo real (SSE)" state={SSE_STATE_LABELS[sseState]} />
          <div className="saude-row">
            <span className="saude-row__label">Versão</span>
            <span className="saude-row__value">{health.version}</span>
          </div>
          <div className="saude-row">
            <span className="saude-row__label">Tempo ativo</span>
            <span className="saude-row__value">{formatUptime(health.uptime_seconds)}</span>
          </div>
          <div className="saude-row">
            <span className="saude-row__label">Ambiente</span>
            <span className="saude-row__value">{health.env}</span>
          </div>
        </section>
      )}

      <section className="glass-card saude-panel" style={{ marginTop: 20 }}>
        <h2>Teste de notificação</h2>
        <p style={{ marginTop: 0, fontSize: 13, color: '#4b4b52' }}>
          Aciona o envio real (ou mostra <code>not_configured</code> sem fingir entrega, se não houver
          `BOT_TOKEN`).
        </p>
        <label>
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
        <label>
          Mensagem
          <input value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <button
          type="button"
          className="crud-form__submit fill-button"
          onClick={sendTest}
          onPointerDown={fillOrigin}
          disabled={sending || recipientId === ''}
        >
          {sending ? 'Enviando…' : 'Enviar teste'}
        </button>
        {testResult && <p className="saude-page__result">{testResult}</p>}
        {testError && (
          <p role="alert" className="saude-page__error">
            {testError}
          </p>
        )}
      </section>
    </main>
  )
}
