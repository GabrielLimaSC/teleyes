import { useCallback, useEffect, useState } from 'react'
import { MatchCard } from '../components/MatchCard'
import { fetchRecipients, fetchRules, fetchSources } from '../api/lookups'
import { fetchMatches } from '../api/matches'
import type { MatchFilters, MatchSort } from '../api/matches'
import type { Match, Recipient, Rule, Source } from '../api/types'
import '../components/GlassCard.css'
import '../components/CrudTable.css'
import './HistoricoPage.css'

const DELIVERY_STATUS_OPTIONS = [
  { value: '', label: 'Qualquer status' },
  { value: 'sent', label: 'Entregue' },
  { value: 'historical', label: 'Histórico — sem alerta' },
  { value: 'failed', label: 'Falha no envio' },
  { value: 'not_configured', label: 'Notificação desativada' },
  { value: 'not_allowlisted', label: 'Destinatário não autorizado' },
  { value: 'duplicate', label: 'Duplicado' },
]

// S7-07: ranking por preço — mais útil com uma regra específica filtrada
// (comparar o mesmo produto/promoção), mas funciona com qualquer combinação
// de filtros, inclusive nenhum.
const SORT_OPTIONS: Array<{ value: '' | MatchSort; label: string }> = [
  { value: '', label: 'Mais recentes primeiro' },
  { value: 'price_asc', label: 'Menor preço primeiro' },
  { value: 'price_desc', label: 'Maior preço primeiro' },
]

export interface FilterForm {
  ruleId: string
  sourceId: string
  recipientId: string
  minPriceReais: string
  maxPriceReais: string
  deliveryStatus: string
  sort: '' | MatchSort
}

const EMPTY_FILTERS: FilterForm = {
  ruleId: '',
  sourceId: '',
  recipientId: '',
  minPriceReais: '',
  maxPriceReais: '',
  deliveryStatus: '',
  sort: '',
}

export function toApiFilters(form: FilterForm): MatchFilters {
  const filters: MatchFilters = {}
  if (form.ruleId !== '') filters.ruleId = Number(form.ruleId)
  if (form.sourceId !== '') filters.sourceId = Number(form.sourceId)
  if (form.recipientId !== '') filters.recipientId = Number(form.recipientId)
  if (form.minPriceReais !== '') filters.minPriceCents = Math.round(Number(form.minPriceReais) * 100)
  if (form.maxPriceReais !== '') filters.maxPriceCents = Math.round(Number(form.maxPriceReais) * 100)
  if (form.deliveryStatus !== '') filters.deliveryStatus = form.deliveryStatus
  if (form.sort !== '') filters.sort = form.sort
  return filters
}

export function HistoricoPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [form, setForm] = useState<FilterForm>(EMPTY_FILTERS)
  const [matches, setMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchRules().then(setRules).catch(() => setRules([]))
    fetchSources().then(setSources).catch(() => setSources([]))
    fetchRecipients().then(setRecipients).catch(() => setRecipients([]))
  }, [])

  // S7-02: named and stable per filter combination so a visible "Atualizar"
  // button can trigger the exact same reload on demand, not just the effect
  // below reacting to a filter change.
  const loadMatches = useCallback(() => {
    setLoading(true)
    fetchMatches(toApiFilters(form))
      .then((data) => {
        setMatches(data)
        setError(null)
      })
      .catch(() => setError('Não foi possível carregar o histórico com esses filtros.'))
      .finally(() => setLoading(false))
    // form is a plain object rebuilt on every change; comparing its fields
    // individually would just repeat this same dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    form.ruleId,
    form.sourceId,
    form.recipientId,
    form.minPriceReais,
    form.maxPriceReais,
    form.deliveryStatus,
    form.sort,
  ])

  useEffect(() => {
    loadMatches()
  }, [loadMatches])

  const updateField = (field: keyof FilterForm) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }))

  // S10-07: repeated at the top of the results (S10-05 comp's `.section-row`
  // next to "Resultados") — the same label the "Ordenar por" select already
  // shows, just surfaced without having to look back up at the filter panel.
  const sortLabel = SORT_OPTIONS.find((option) => option.value === form.sort)?.label ?? SORT_OPTIONS[0].label

  return (
    <main className="historico-page">
      <h1>Histórico</h1>
      {/* S10-07: filters grouped in their own panel (S10-05 comp's
          `.history-filters`/`.history-filter-grid`) — Regra/Fonte/
          Destinatário/Entrega in one row, Preço mínimo/máximo/Ordenar por
          in the next, "Limpar filtros"/"Atualizar" on their own row after.
          Same fields, same filtering logic — reordered/regrouped only. */}
      <form
        className="glass-card historico-page__filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="historico-page__filter-grid">
          <label>
            Regra
            <select value={form.ruleId} onChange={(event) => updateField('ruleId')(event.target.value)}>
              <option value="">Todas</option>
              {rules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fonte
            <select
              value={form.sourceId}
              onChange={(event) => updateField('sourceId')(event.target.value)}
            >
              <option value="">Todas</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Destinatário
            <select
              value={form.recipientId}
              onChange={(event) => updateField('recipientId')(event.target.value)}
            >
              <option value="">Todos</option>
              {recipients.map((recipient) => (
                <option key={recipient.id} value={recipient.id}>
                  {recipient.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Entrega
            <select
              value={form.deliveryStatus}
              onChange={(event) => updateField('deliveryStatus')(event.target.value)}
            >
              {DELIVERY_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Preço mínimo (R$)
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.minPriceReais}
              onChange={(event) => updateField('minPriceReais')(event.target.value)}
            />
          </label>
          <label>
            Preço máximo (R$)
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.maxPriceReais}
              onChange={(event) => updateField('maxPriceReais')(event.target.value)}
            />
          </label>
          <label className="historico-page__filter-grid-span2">
            Ordenar por
            <select value={form.sort} onChange={(event) => updateField('sort')(event.target.value)}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="historico-page__filter-actions">
          <button type="button" onClick={() => setForm(EMPTY_FILTERS)}>
            Limpar filtros
          </button>
          <button type="button" onClick={loadMatches}>
            Atualizar
          </button>
        </div>
      </form>

      {loading && <p>Carregando…</p>}
      {error && (
        <p role="alert" className="historico-page__error">
          {error}
        </p>
      )}
      {!loading && !error && (
        <>
          <div className="crud-section-row">
            <h2>Resultados</h2>
            <p>{sortLabel}</p>
          </div>
          {matches.length === 0 && <p>Nenhum match encontrado com esses filtros.</p>}
          <div className="historico-page__list">
            {matches.map((match) => (
              <MatchCard
                key={match.id}
                match={match}
                rule={rules.find((rule) => rule.id === match.rule_id)}
                source={sources.find((source) => source.id === match.source_id)}
                recipients={recipients}
                isLowestPriceEver={match.is_lowest_price_ever}
                groupedSourceNames={match.grouped_source_ids
                  ?.map((sourceId) => sources.find((source) => source.id === sourceId)?.name)
                  .filter((name): name is string => Boolean(name))}
              />
            ))}
          </div>
        </>
      )}
    </main>
  )
}
