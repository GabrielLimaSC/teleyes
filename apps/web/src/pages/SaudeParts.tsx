import { HelpTip } from '../components/HelpTip'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CollectorHistory, HeartbeatBucket, SystemEvent } from '../api/healthHistory'
import { formatClockMoment } from '../utils/dates'
import {
  EVENT_KIND,
  availability,
  barKind,
  barTooltip,
  coverageNote,
  formatAvailability,
  hourLabel,
  normalizeBuckets,
} from './saudeModel'
import type { ServiceView, Verdict } from './saudeModel'

export function VerdictStrip({
  verdict,
  uptime,
  env,
  version,
}: {
  verdict: Verdict
  uptime: string
  env: string
  version: string
}) {
  return (
    <section className={`plane-pearl saude-verdict saude-tone-${verdict.tone}`} aria-label="Veredito">
      <span className="saude-verdict__dot" aria-hidden="true" />
      <div className="saude-verdict__text">
        <h2>{verdict.title}</h2>
        <p>{verdict.detail}</p>
      </div>
      <dl className="saude-verdict__meta">
        <div>
          <dt>Tempo ativo</dt>
          <dd>{uptime}</dd>
        </div>
        <div>
          <dt>Ambiente</dt>
          <dd>{env}</dd>
        </div>
        <div>
          <dt>Versão</dt>
          <dd>v{version}</dd>
        </div>
      </dl>
    </section>
  )
}

export function ServiceCard({
  view,
  detail,
  buckets,
}: {
  view: ServiceView
  detail: ReactNode
  buckets: HeartbeatBucket[]
}) {
  const bars = normalizeBuckets(buckets)
  const percent = formatAvailability(availability(bars))
  return (
    <article className="plane-pearl saude-service" data-service={view.key}>
      <header className="saude-service__head">
        <h3>{view.name}</h3>
        {view.key === 'listener' && (
          <HelpTip term="Leitor do Telegram">
            A parte do teleyes que acompanha os seus grupos e procura as ofertas. Se parar, nada novo chega.
          </HelpTip>
        )}
        <span className={`saude-pill saude-tone-${view.tone}`}>{view.pill}</span>
      </header>
      <p className="saude-service__detail">{detail}</p>
      <div
        className="saude-bars"
        role="img"
        aria-label={`${view.name}, últimas 24 horas: disponibilidade ${percent}`}
      >
        {bars.map((bucket, index) => (
          <span
            key={bucket?.hour ?? `empty-${index}`}
            className={`saude-bar saude-bar--${barKind(bucket)}`}
            title={barTooltip(bucket)}
          />
        ))}
      </div>
      <footer className="saude-service__foot">
        <span>24h</span>
        <span data-testid={`availability-${view.key}`}>{percent}</span>
      </footer>
    </article>
  )
}

export interface CollectorKpi {
  label: string
  value: string
}

export function CollectorCard({
  collector,
  kpis,
}: {
  collector: CollectorHistory | null
  kpis: CollectorKpi[]
}) {
  const hours = normalizeBuckets(collector?.hours ?? [])
  const peak = Math.max(1, ...hours.map((hour) => hour?.evaluated ?? 0))
  const note = collector === null ? null : coverageNote(collector.coverage_since)
  const first = hours.find((hour) => hour !== null)
  return (
    <section className="plane-pearl saude-panel saude-collector">
      <div className="saude-collector__head">
        <div>
          <h2>Coletor</h2>
          <p className="saude-panel__sub">
            Mensagens analisadas por hora · últimas 24h{note !== null && <> · {note}</>}
          </p>
        </div>
        {collector !== null && (
          <div className="saude-collector__total">
            <strong>{collector.totals.evaluated.toLocaleString('pt-BR')}</strong>
            <span>nas últimas 24h</span>
          </div>
        )}
      </div>
      <div className="saude-chart" role="img" aria-label="Mensagens analisadas por hora nas últimas 24 horas">
        {hours.map((hour, index) => {
          const value = hour?.evaluated ?? null
          const last = index === hours.length - 1
          return (
            <span
              key={hour?.hour ?? `empty-${index}`}
              className={`saude-chart__bar${value === null ? ' saude-chart__bar--none' : ''}${last ? ' saude-chart__bar--now' : ''}`}
              style={value === null ? undefined : { height: `${Math.max(4, (value / peak) * 100)}%` }}
              title={
                hour === null || value === null
                  ? 'coletando'
                  : `${hourLabel(hour.hour)} · ${value.toLocaleString('pt-BR')} mensagens analisadas`
              }
            />
          )
        })}
      </div>
      <div className="saude-chart__axis" aria-hidden="true">
        <span>{first ? hourLabel(first.hour) : ''}</span>
        <span>agora</span>
      </div>
      {kpis.length > 0 && (
        <dl className="saude-stats">
          {kpis.map((kpi) => (
            <div className="saude-stats__item" key={kpi.label}>
              <dt>{kpi.label}</dt>
              <dd>{kpi.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

export function EventsCard({ events, failed }: { events: SystemEvent[] | null; failed: boolean }) {
  return (
    <section className="plane-pearl saude-events">
      <h2>Eventos recentes</h2>
      {events === null && <p className="saude-events__empty">{failed ? 'Não foi possível carregar os eventos.' : 'Carregando…'}</p>}
      {events !== null && events.length === 0 && (
        <p className="saude-events__empty">Nenhum evento registrado ainda.</p>
      )}
      {events !== null && events.length > 0 && (
        <ul className="saude-events__list">
          {events.map((event) => {
            const kind = EVENT_KIND[event.kind]
            return (
              <li key={event.id}>
                <time dateTime={event.at}>{formatEventTime(event.at)}</time>
                <span className={`saude-pill saude-tone-${kind.tone}`}>{kind.label}</span>
                <span className="saude-events__summary">{event.summary}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function formatEventTime(iso: string): string {
  const moment = formatClockMoment(iso)
  return moment.startsWith('às ') ? moment.slice(3) : moment.replace(' às ', ' ')
}

export function TelegramPreview({ text }: { text: string }) {
  const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="saude-preview" aria-label="Prévia no Telegram">
      <div className="saude-preview__eyebrow">Prévia no Telegram</div>
      <div className="saude-preview__row">
        <span className="saude-preview__avatar" aria-hidden="true" />
        <div className="saude-preview__bubble">
          <strong>teleyes</strong>
          <p>{text.trim() === '' ? '…' : text}</p>
          <time>{time}</time>
        </div>
      </div>
    </div>
  )
}

/** "atualizado há Ns", ticking on its own so the page does not re-render every second. */
export function UpdatedAgo({ at }: { at: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (at === null) return <>carregando…</>
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  return <>atualizado há {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}min`}</>
}

