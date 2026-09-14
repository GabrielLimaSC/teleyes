import { useCallback, useEffect, useState } from 'react'
import { MatchCard } from '../components/MatchCard'
import { fetchRecipients, fetchRules, fetchSources } from '../api/lookups'
import { fetchMatches } from '../api/matches'
import type { MatchFilters } from '../api/matches'
import type { Match, Recipient, Rule, Source } from '../api/types'
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

export interface FilterForm {
  ruleId: string
  sourceId: string
  recipientId: string
  minPriceReais: string
  maxPriceReais: string
  deliveryStatus: string
}

const EMPTY_FILTERS: FilterForm = {
  ruleId: '',
  sourceId: '',
  recipientId: '',
  minPriceReais: '',
  maxPriceReais: '',
  deliveryStatus: '',
}

export function toApiFilters(form: FilterForm): MatchFilters {
  const filters: MatchFilters = {}
  if (form.ruleId !== '') filters.ruleId = Number(form.ruleId)
  if (form.sourceId !== '') filters.sourceId = Number(form.sourceId)
  if (form.recipientId !== '') filters.recipientId = Number(form.recipientId)
  if (form.minPriceReais !== '') filters.minPriceCents = Math.round(Number(form.minPriceReais) * 100)
  if (form.maxPriceReais !== '') filters.maxPriceCents = Math.round(Number(form.maxPriceReais) * 100)
  if (form.deliveryStatus !== '') filters.deliveryStatus = form.deliveryStatus
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
  ])

  useEffect(() => {
    loadMatches()
  }, [loadMatches])

  const updateField = (field: keyof FilterForm) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }))

  return (
    <main className="historico-page">
      <h1>Histórico</h1>
      <form className="historico-page__filters" onSubmit={(event) => event.preventDefault()}>
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
          <select value={form.sourceId} onChange={(event) => updateField('sourceId')(event.target.value)}>
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
        <button type="button" onClick={() => setForm(EMPTY_FILTERS)}>
          Limpar filtros
        </button>
        <button type="button" onClick={loadMatches}>
          Atualizar
        </button>
      </form>

      {loading && <p>Carregando…</p>}
      {error && (
        <p role="alert" className="historico-page__error">
          {error}
        </p>
      )}
      {!loading && !error && matches.length === 0 && <p>Nenhum match encontrado com esses filtros.</p>}
      <div className="historico-page__list">
        {matches.map((match) => (
          <MatchCard
            key={match.id}
            match={match}
            rule={rules.find((rule) => rule.id === match.rule_id)}
            source={sources.find((source) => source.id === match.source_id)}
            recipients={recipients}
          />
        ))}
      </div>
    </main>
  )
}
