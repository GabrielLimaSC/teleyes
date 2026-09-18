import { useEffect, useMemo, useState } from 'react'
import { MatchCard } from '../components/MatchCard'
import { fetchRecipients, fetchRules, fetchSources } from '../api/lookups'
import { fetchMetrics } from '../api/metrics'
import { useLiveMatches } from '../hooks/useLiveMatches'
import type { FeedConnectionState } from '../hooks/useLiveMatches'
import type { Match, Recipient, Rule, Source } from '../api/types'
import '../styles/materials.css'
import '../components/FillButton.css'
import './FeedPage.css'

const CONNECTION_LABELS: Record<FeedConnectionState, { label: string; color: string }> = {
  connecting: { label: 'SSE conectando…', color: '#8b5a08' },
  open: { label: 'SSE conectado', color: '#176945' },
  error: { label: 'SSE caiu — tentando reconectar…', color: '#a32a24' },
}

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function FeedPage() {
  const { matches, loading, error, connectionState, refresh } = useLiveMatches()
  const [rules, setRules] = useState<Rule[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [readCount, setReadCount] = useState<number | null>(null)
  const [selectedRuleId, setSelectedRuleId] = useState<number | null>(null)

  useEffect(() => {
    fetchRules().then(setRules).catch(() => setRules([]))
    fetchSources().then(setSources).catch(() => setSources([]))
    fetchRecipients().then(setRecipients).catch(() => setRecipients([]))
    // S11-03: "Mensagens lidas" é cumulativo desde sempre (soma de
    // reason=vista em todas as fontes) — não existe endpoint por período,
    // então o painel rotula isso explicitamente em vez de sugerir "hoje".
    fetchMetrics()
      .then((counters) => {
        const total = counters
          .filter((counter) => counter.reason === 'vista')
          .reduce((sum, counter) => sum + counter.count, 0)
        setReadCount(total)
      })
      .catch(() => setReadCount(null))
  }, [])

  // Contagem por regra vem sempre da lista completa (não filtrada) — é o que
  // aparece do lado de cada regra na trilha, mesmo quando outra regra está
  // selecionada.
  const ruleCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const match of matches) {
      counts.set(match.rule_id, (counts.get(match.rule_id) ?? 0) + 1)
    }
    return counts
  }, [matches])

  const visibleMatches: Match[] = useMemo(
    () => (selectedRuleId === null ? matches : matches.filter((match) => match.rule_id === selectedRuleId)),
    [matches, selectedRuleId],
  )

  const summary = useMemo(() => {
    const sent = visibleMatches.reduce(
      (count, match) => count + match.deliveries.filter((delivery) => delivery.status === 'sent').length,
      0,
    )
    const prices = visibleMatches
      .map((match) => match.price_cents)
      .filter((price): price is number => price !== null)
    return {
      matches: visibleMatches.length,
      sent,
      lowestPrice: prices.length > 0 ? Math.min(...prices) : null,
    }
  }, [visibleMatches])

  const connectionLabel = CONNECTION_LABELS[connectionState]

  return (
    <main className="feed-page">
      <div className="feed-page__header">
        <div>
          <h1>Feed ao vivo</h1>
          <p className="feed-page__subtitle">Ofertas encontradas pelas suas regras, em tempo real.</p>
        </div>
        <div className="feed-page__header-actions">
          <span
            className="feed-page__connection-badge"
            role="status"
            style={{ color: connectionLabel.color, borderColor: connectionLabel.color }}
          >
            <span className="feed-page__connection-dot" style={{ background: connectionLabel.color }} />
            {connectionLabel.label}
          </span>
          <button
            type="button"
            className="plane-action plane-action--secondary fill-button feed-page__refresh"
            onClick={refresh}
          >
            Atualizar
          </button>
        </div>
      </div>

      {loading && <p>Carregando…</p>}
      {error && (
        <p role="alert" className="feed-page__error">
          {error}
        </p>
      )}

      {!loading && !error && (
        <div className="feed-page__grid">
          <aside className="plane-glass feed-rail">
            <div>
              <div className="feed-rail__eyebrow">Filtrar por regra</div>
              <div className="feed-rail__list">
                <button
                  type="button"
                  className={`feed-rail__rule${selectedRuleId === null ? ' feed-rail__rule--active' : ''}`}
                  onClick={() => setSelectedRuleId(null)}
                >
                  <span>Todas as regras</span>
                  <span>{matches.length}</span>
                </button>
                {rules.map((rule) => (
                  <button
                    key={rule.id}
                    type="button"
                    className={`feed-rail__rule${selectedRuleId === rule.id ? ' feed-rail__rule--active' : ''}`}
                    onClick={() => setSelectedRuleId(rule.id)}
                  >
                    <span>{rule.name}</span>
                    <span>{ruleCounts.get(rule.id) ?? 0}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="feed-rail__divider" />
            <div>
              <div className="feed-rail__eyebrow">Fontes</div>
              <div className="feed-rail__sources">
                {sources.map((source) => (
                  <div key={source.id} className="feed-rail__source">
                    <span>{source.name}</span>
                    <span
                      className="feed-rail__status"
                      style={{ color: source.active ? '#176945' : '#47566e' }}
                    >
                      <span
                        className="feed-rail__status-dot"
                        style={{ background: source.active ? '#176945' : '#47566e' }}
                      />
                      {source.active ? 'ativa' : 'inativa'}
                    </span>
                  </div>
                ))}
                {sources.length === 0 && <p className="feed-rail__empty">Nenhuma fonte cadastrada.</p>}
              </div>
            </div>
          </aside>

          <div className="feed-page__list">
            {visibleMatches.length === 0 && matches.length === 0 && <p>Nenhum match ainda.</p>}
            {visibleMatches.length === 0 && matches.length > 0 && (
              <p>Nenhum match para esta regra ainda.</p>
            )}
            {visibleMatches.map((match) => (
              <div key={match.id} className="feed-page__card">
                <MatchCard
                  match={match}
                  rule={rules.find((rule) => rule.id === match.rule_id)}
                  source={sources.find((source) => source.id === match.source_id)}
                  recipients={recipients}
                  isLowestPriceEver={match.is_lowest_price_ever}
                  groupedSourceNames={match.grouped_source_ids
                    ?.map((sourceId) => sources.find((source) => source.id === sourceId)?.name)
                    .filter((name): name is string => Boolean(name))}
                />
              </div>
            ))}
          </div>

          <aside className="plane-glass feed-summary">
            <div className="feed-rail__eyebrow">Resumo</div>
            <div className="feed-summary__grid">
              <div className="feed-summary__tile">
                <div className="feed-summary__label">Matches</div>
                <div className="feed-summary__value">{summary.matches}</div>
              </div>
              <div className="feed-summary__tile">
                <div className="feed-summary__label">Enviados</div>
                <div className="feed-summary__value">{summary.sent}</div>
              </div>
              <div className="feed-summary__tile">
                <div className="feed-summary__label">Menor preço</div>
                <div className="feed-summary__value feed-summary__value--price">
                  {summary.lowestPrice !== null ? formatCurrency(summary.lowestPrice) : '—'}
                </div>
              </div>
              <div className="feed-summary__tile">
                <div className="feed-summary__label">Mensagens lidas</div>
                <div className="feed-summary__value">{readCount ?? '…'}</div>
                <div className="feed-summary__caption">cumulativo, não é só hoje</div>
              </div>
            </div>
          </aside>
        </div>
      )}
    </main>
  )
}
