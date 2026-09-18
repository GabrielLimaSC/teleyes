import { useCallback, useEffect, useMemo, useState } from 'react'
import { CategoryIcon } from '../components/CategoryIcon'
import { categorize, CATEGORY_BACKGROUND } from '../components/matchCategory'
import { summarizeDeliveryStatus } from '../components/deliveryStatus'
import { Tooltip } from '../components/Tooltip'
import { cardTitle, productText } from '../components/matchTitle'
import { fetchRecipients, fetchRules, fetchSources } from '../api/lookups'
import { fetchMatches } from '../api/matches'
import type { MatchFilters, MatchSort } from '../api/matches'
import type { Match, Recipient, Rule, Source } from '../api/types'
import '../styles/materials.css'
import '../components/FillButton.css'
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

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatPrice(cents: number | null): string {
  if (cents === null) return 'Preço não identificado'
  return formatCurrency(cents)
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

// Mesma regra da S10-06 (MatchCard) — "Hoje"/"Ontem" em fuso local, data
// completa daí em diante.
function formatMatchedAt(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (isSameLocalDay(date, now)) return `Hoje, ${time}`

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameLocalDay(date, yesterday)) return `Ontem, ${time}`

  return date.toLocaleString('pt-BR')
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** S11-04: gera o CSV a partir do que já está calculado pra tela — mesmos
 * valores exibidos (título cortado, nomes de regra/fonte, hora formatada,
 * preço formatado, status de entrega), não os campos crus da API. Sem
 * endpoint novo: é puramente client-side a partir de `matches` já
 * carregados. */
function buildCsv(rows: HistoricoRow[]): string {
  const header = ['Produto', 'Regra', 'Fonte', 'Hora', 'Preço', 'Entrega']
  const lines = [header.map(csvField).join(',')]
  for (const row of rows) {
    lines.push(
      [row.title, row.ruleName, row.sourceName, row.time, row.priceText, row.deliveryLabel]
        .map(csvField)
        .join(','),
    )
  }
  return lines.join('\r\n')
}

function downloadCsv(csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `historico-teleyes-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

interface HistoricoRow {
  match: Match
  rule: Rule | undefined
  title: string
  wasTruncated: boolean
  linkCutText: string
  ruleName: string
  sourceName: string
  groupedSourceNames: string[]
  time: string
  priceText: string
  deliveryLabel: string
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

  // S11-04: tudo calculado no cliente a partir de `matches` — o conjunto já
  // filtrado/buscado (fetchMatches(toApiFilters(form))), sem endpoint novo.
  const rows: HistoricoRow[] = useMemo(
    () =>
      matches.map((match) => {
        const rule = rules.find((candidate) => candidate.id === match.rule_id)
        const source = sources.find((candidate) => candidate.id === match.source_id)
        const linkCutText = productText(match.message_text)
        const title = cardTitle(match.message_text, rule)
        const priceText =
          match.price_cash_cents !== null && match.price_card_cents !== null
            ? `${formatCurrency(match.price_cash_cents)} (à vista) / ${formatCurrency(match.price_card_cents)} (cartão)`
            : formatPrice(match.price_cents)
        return {
          match,
          rule,
          title,
          wasTruncated: title !== linkCutText,
          linkCutText,
          ruleName: rule?.name ?? `#${match.rule_id}`,
          sourceName: source?.name ?? `#${match.source_id}`,
          // S7-11: the same "Visto em" info MatchCard shows — the other
          // sources that posted this exact promotion within the grouping
          // window (chained), never lost even though only this row exists.
          groupedSourceNames: (match.grouped_source_ids ?? [])
            .map((sourceId) => sources.find((candidate) => candidate.id === sourceId)?.name)
            .filter((name): name is string => Boolean(name)),
          time: formatMatchedAt(match.matched_at),
          priceText,
          deliveryLabel: summarizeDeliveryStatus(match.deliveries).label,
        }
      }),
    [matches, rules, sources],
  )

  const stats = useMemo(() => {
    const prices = matches.map((match) => match.price_cents).filter((price): price is number => price !== null)
    const deliveriesDone = matches.reduce(
      (count, match) => count + match.deliveries.filter((delivery) => delivery.status === 'sent').length,
      0,
    )
    return {
      count: matches.length,
      avgPrice: prices.length > 0 ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length) : null,
      lowestPrice: prices.length > 0 ? Math.min(...prices) : null,
      deliveriesDone,
    }
  }, [matches])

  const exportCsv = () => downloadCsv(buildCsv(rows))

  return (
    <main className="historico-page">
      <div className="historico-page__header">
        <div>
          <h1>Histórico</h1>
          <p className="historico-page__subtitle">
            {matches.length} {matches.length === 1 ? 'resultado' : 'resultados'} · {sortLabel.toLowerCase()}
          </p>
        </div>
        <div className="historico-page__header-actions">
          <button
            type="button"
            className="plane-action plane-action--secondary"
            onClick={exportCsv}
            disabled={rows.length === 0}
          >
            Exportar CSV
          </button>
          <button type="button" className="plane-action fill-button" onClick={loadMatches}>
            Atualizar
          </button>
        </div>
      </div>

      <div className="historico-page__grid">
        {/* S10-07: mesmos campos de filtro de sempre (Regra/Fonte/
            Destinatário/Entrega/Preço/Ordenar por), só restilizados pro
            plano vidro — nenhum campo novo, nenhum removido. */}
        <form className="plane-glass historico-rail" onSubmit={(event) => event.preventDefault()}>
          <div className="historico-rail__head">
            <span className="historico-rail__eyebrow">Filtros</span>
            <button type="button" className="historico-rail__clear" onClick={() => setForm(EMPTY_FILTERS)}>
              Limpar filtros
            </button>
          </div>
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
          <div className="historico-rail__price-grid">
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
          </div>
          <div className="historico-rail__divider" />
          <label>
            Ordenar por
            <select value={form.sort} onChange={(event) => updateField('sort')(event.target.value)}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="plane-action fill-button historico-rail__apply" onClick={loadMatches}>
            Aplicar filtros
          </button>
        </form>

        <div className="historico-page__results">
          {loading && <p>Carregando…</p>}
          {error && (
            <p role="alert" className="historico-page__error">
              {error}
            </p>
          )}
          {!loading && !error && (
            <>
              <div className="historico-stats">
                <div className="historico-stats__tile">
                  <div className="historico-stats__label">Matches no período</div>
                  <div className="historico-stats__value">{stats.count}</div>
                </div>
                <div className="historico-stats__tile">
                  <div className="historico-stats__label">Preço médio</div>
                  <div className="historico-stats__value">
                    {stats.avgPrice !== null ? formatCurrency(stats.avgPrice) : '—'}
                  </div>
                </div>
                <div className="historico-stats__tile">
                  <div className="historico-stats__label">Menor preço</div>
                  <div className="historico-stats__value">
                    {stats.lowestPrice !== null ? formatCurrency(stats.lowestPrice) : '—'}
                  </div>
                </div>
                <div className="historico-stats__tile">
                  <div className="historico-stats__label">Entregas feitas</div>
                  <div className="historico-stats__value">{stats.deliveriesDone}</div>
                </div>
              </div>

              {rows.length === 0 && <p>Nenhum match encontrado com esses filtros.</p>}
              {rows.length > 0 && (
                <div className="plane-pearl historico-table">
                  <div className="historico-table__row historico-table__row--head">
                    <span>Produto</span>
                    <span>Regra · fonte</span>
                    <span>Hora</span>
                    <span className="historico-table__cell--right">Preço</span>
                    <span className="historico-table__cell--right">Entrega</span>
                  </div>
                  {rows.map((row) => {
                    const category = categorize(row.match.message_text)
                    const titleNode = <span className="historico-table__title">{row.title}</span>
                    return (
                      <div key={row.match.id} className="historico-table__row">
                        <div className="historico-table__product">
                          <span
                            className="historico-table__icon"
                            style={{ background: CATEGORY_BACKGROUND[category] }}
                          >
                            <CategoryIcon category={category} />
                          </span>
                          {row.wasTruncated ? (
                            <Tooltip label={row.linkCutText}>{titleNode}</Tooltip>
                          ) : (
                            titleNode
                          )}
                        </div>
                        <span className="historico-table__meta">
                          {row.ruleName} · {row.sourceName}
                          {row.groupedSourceNames.length > 0 && (
                            <span className="historico-table__grouped-sources">
                              Visto em: {row.groupedSourceNames.join(', ')}
                            </span>
                          )}
                        </span>
                        <span className="historico-table__time">{row.time}</span>
                        <div className="historico-table__cell--right">
                          <div className="historico-table__price">{formatPrice(row.match.price_cents)}</div>
                          {row.match.is_lowest_price_ever ? (
                            <span className="historico-table__price-note historico-table__price-note--lowest">
                              Menor já visto
                            </span>
                          ) : row.rule?.max_price_cents != null ? (
                            <span className="historico-table__price-note">
                              Teto {formatCurrency(row.rule.max_price_cents)}
                            </span>
                          ) : null}
                        </div>
                        <div className="historico-table__cell--right">
                          <span className="historico-table__delivery">{row.deliveryLabel}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  )
}
