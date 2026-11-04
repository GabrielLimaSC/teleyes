import { useCallback, useEffect, useState } from 'react'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import { deleteSource, fetchSourcesActivity, listSources, pauseSource } from '../api/sources'
import { ApiError } from '../api/auth'
import { reportFailure } from '../api/demo'
import type { Source, SourceActivity, SourcesActivity } from '../api/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { EmptyState } from '../components/EmptyState'
import { RowActionsMenu } from '../components/RowActionsMenu'
import { StatusToggle } from '../components/StatusToggle'
import { useSetupStatus } from '../hooks/useSetupStatus'
import { formatDayMonthClock, formatRelativeAgo } from '../utils/dates'
import { useFillOrigin } from '../utils/useFillOrigin'
import { FontesRail } from './FontesRail'
import { barScale, buildBars, buildKpis, sourceHue, sourceInitial } from './sourceStats'
import type { Bar } from './sourceStats'
import '../components/FillButton.css'
import './FontesPage.css'

const NOW_TICK_MS = 30_000

function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), NOW_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

function formatDay(day: string): string {
  const [, month, date] = day.split('-')
  return `${date}/${month}`
}

function barsLabel(bars: Bar[]): string {
  if (bars.length === 0) return 'Sem dados de atividade'
  return `Avaliações por dia: ${bars
    .map((bar) => `${formatDay(bar.day)} ${bar.value === null ? 'coletando' : bar.value}`)
    .join(', ')}`
}

function MiniBars({ bars, hue }: { bars: Bar[]; hue: number }) {
  if (bars.length === 0) {
    return <span className="fontes-bars fontes-bars--empty" aria-label="Sem dados de atividade">—</span>
  }
  return (
    <span className="fontes-bars" role="img" aria-label={barsLabel(bars)}>
      {bars.map((bar, index) => (
        <span
          key={bar.day}
          className={`fontes-bars__bar${bar.value === null ? ' fontes-bars__bar--pending' : ''}${index === bars.length - 1 ? ` fontes-bars__bar--last fontes-hue-${hue}` : ''}`}
          style={bar.value === null ? undefined : { height: `${Math.max(12, Math.round(bar.ratio * 100))}%` }}
        />
      ))}
    </span>
  )
}

export function FontesPage() {
  const { csrfToken } = useAuth()
  const fillOrigin = useFillOrigin()
  const now = useNow()
  const { status: setupStatus } = useSetupStatus()
  const [sources, setSources] = useState<Source[]>([])
  const [activity, setActivity] = useState<SourcesActivity | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [editTarget, setEditTarget] = useState<Source | null>(null)
  const [focusSignal, setFocusSignal] = useState(0)
  const [pausingId, setPausingId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Source | null>(null)
  const [deleting, setDeleting] = useState(false)

  const reload = useCallback(() => {
    setLoading(true)
    // Activity is decoration: if it fails the table still works, with "—" where it would be.
    const activityRequest = fetchSourcesActivity(7).catch(() => null)
    Promise.all([listSources(true), activityRequest])
      .then(([sourcesData, activityData]) => {
        setSources(sourcesData)
        setActivity(activityData)
        setListError(null)
      })
      .catch(() => setListError('Não foi possível carregar as fontes.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(reload, [reload])

  const handlePause = (source: Source) => {
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    setPausingId(source.id)
    pauseSource(csrfToken, source.id)
      .then(reload)
      .catch((error: unknown) => reportFailure(error, 'Não foi possível pausar a fonte.', setListError))
      .finally(() => setPausingId(null))
  }

  const confirmDelete = () => {
    if (deleteTarget === null) return
    if (csrfToken === null) {
      setDeleteTarget(null)
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    setDeleting(true)
    deleteSource(csrfToken, deleteTarget.id)
      .then(() => {
        if (editTarget?.id === deleteTarget.id) setEditTarget(null)
        reload()
      })
      .catch((error: unknown) => {
        reportFailure(error, error instanceof ApiError ? error.message : 'Não foi possível excluir a fonte.', setListError)
      })
      .finally(() => {
        setDeleting(false)
        setDeleteTarget(null)
      })
  }

  const kpis = buildKpis(sources, activity, (iso) => formatDayMonthClock(iso))
  const scale = barScale(activity)
  const activityById = new Map<number, SourceActivity>((activity?.sources ?? []).map((row) => [row.source_id, row]))

  const kpiCards: { label: string; value: string; sub: string }[] = [
    { label: 'Fontes ativas', ...kpis.active },
    { label: 'Avaliações · hoje', ...kpis.evaluated },
    { label: 'Matches · 7d', ...kpis.matches },
    {
      label: 'Último match',
      value: kpis.lastMatch.at === null ? '—' : formatRelativeAgo(kpis.lastMatch.at, now),
      sub: kpis.lastMatch.at === null ? (activity === null ? 'coletando' : 'nenhum ainda') : (kpis.lastMatch.source ?? ''),
    },
  ]

  return (
    <main className="crud-page fontes-page">
      <div className="fontes-page__header">
        <div>
          <h1>Fontes</h1>
          <p className="fontes-page__subtitle">Grupos e canais do Telegram que o teleyes escuta.</p>
        </div>
        <button
          type="button"
          className="plane-action fill-button fontes-page__new"
          onClick={() => {
            setEditTarget(null)
            setFocusSignal((value) => value + 1)
          }}
          onPointerDown={fillOrigin}
        >
          + Nova fonte
        </button>
      </div>

      <dl className="fontes-kpis">
        {kpiCards.map((card) => (
          <div key={card.label} className="plane-pearl fontes-kpi">
            <dt>{card.label}</dt>
            <dd>{card.value}</dd>
            <dd className="fontes-kpi__sub">{card.sub}</dd>
          </div>
        ))}
      </dl>

      <div className="fontes-page__grid">
        <div className="fontes-page__main">
          {loading && <p>Carregando…</p>}
          {listError && (
            <p role="alert" className="fontes-error">
              {listError}
            </p>
          )}
          {!loading && !listError && (
            <div className="plane-pearl fontes-table-wrap">
              <table className="fontes-table">
                <thead>
                  <tr>
                    <th>Fonte</th>
                    <th>Avaliações · 7d</th>
                    <th className="fontes-table__num">Matches · 7d</th>
                    <th>Último match</th>
                    <th>Status</th>
                    <th>
                      <span className="fontes-visually-hidden">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((source) => {
                    const row = activityById.get(source.id)
                    const hue = sourceHue(source.id)
                    return (
                      <tr key={source.id} className={source.active ? '' : 'fontes-table__row--paused'}>
                        <td data-label="Fonte">
                          <div className="fontes-source">
                            <span className={`fontes-avatar fontes-hue-${hue}`} aria-hidden="true">
                              {sourceInitial(source.name)}
                            </span>
                            <span className="fontes-source__text">
                              <span className="fontes-source__name">{source.name}</span>
                              <span className="fontes-source__id">{source.telegram_chat_id}</span>
                            </span>
                          </div>
                        </td>
                        <td data-label="Avaliações · 7d">
                          <MiniBars bars={buildBars(row, scale)} hue={hue} />
                        </td>
                        <td className="fontes-table__num" data-label="Matches · 7d">
                          {row === undefined ? '—' : row.matches}
                        </td>
                        <td data-label="Último match">
                          {row?.last_match_at != null ? (
                            <>
                              <span className="fontes-when">{formatRelativeAgo(row.last_match_at, now)}</span>
                              <span className="fontes-when__date">{formatDayMonthClock(row.last_match_at)}</span>
                            </>
                          ) : (
                            <span className="fontes-when__date">
                              {row === undefined ? '—' : 'Nenhum match ainda'}
                            </span>
                          )}
                        </td>
                        <td data-label="Status">
                          <StatusToggle
                            active={source.active}
                            pausing={pausingId === source.id}
                            onPause={() => handlePause(source)}
                          />
                        </td>
                        <td className="fontes-table__actions" data-label="Ações">
                          <RowActionsMenu
                            label={`Mais ações da fonte ${source.name}`}
                            items={[
                              {
                                key: 'edit',
                                label: 'Editar',
                                onSelect: () => {
                                  setEditTarget(source)
                                  setFocusSignal((value) => value + 1)
                                },
                              },
                              {
                                key: 'delete',
                                label: 'Excluir',
                                onSelect: () => setDeleteTarget(source),
                                danger: true,
                                separatorBefore: true,
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    )
                  })}
                  {sources.length === 0 && (
                    <tr className="fontes-table__empty">
                      <td colSpan={6}>
                        <EmptyState
                          title="Nenhuma fonte ainda"
                          text="Fontes são os grupos e canais do Telegram que o teleyes lê. Sem fonte, nada é monitorado."
                          action={{
                            label: setupStatus?.configured === true ? 'Adicionar da minha conta' : 'Adicionar por chat_id',
                            onClick: () => {
                              setEditTarget(null)
                              setFocusSignal((value) => value + 1)
                            },
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="fontes-page__side">
          <FontesRail
            csrfToken={csrfToken}
            setupStatus={setupStatus}
            sources={sources}
            editTarget={editTarget}
            focusSignal={focusSignal}
            onChanged={reload}
            onCancelEdit={() => setEditTarget(null)}
          />
          <section className="plane-pearl fontes-help">
            <h2>Não aparece na lista?</h2>
            <p>
              A conta precisa estar no grupo. Para canais privados, use “Por chat_id” — o id começa com{' '}
              <code>-100</code>.
            </p>
          </section>
        </div>
      </div>

      {deleteTarget !== null && (
        <ConfirmDialog
          title="Excluir fonte?"
          message={`“${deleteTarget.name}” deixa de ser monitorada. Esta ação não pode ser desfeita.`}
          confirmLabel="Excluir"
          busy={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </main>
  )
}
