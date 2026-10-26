import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import { ApiError } from '../api/auth'
import { reportFailure } from '../api/demo'
import { fetchMatches } from '../api/matches'
import { fetchProduct } from '../api/products'
import {
  createPurchase,
  deletePurchase,
  fetchSavingsReport,
  listPurchases,
  updatePurchase,
} from '../api/purchases'
import type { Purchase, PurchaseInput, ReportItem, SavingsReport } from '../api/purchases'
import { listRules } from '../api/rules'
import type { Rule } from '../api/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { cardTitle } from '../components/matchTitle'
import { EMPTY_DRAFT, valuesFromDraft } from '../economia/purchaseDraft'
import type { EconomiaNavState, LinkOption, PurchaseDraft } from '../economia/purchaseDraft'
import { PurchaseForm } from '../economia/PurchaseForm'
import { ResultsCardPanel } from '../economia/ResultsCardPanel'
import { apiDateToInput, parseApiDate, toDateInputValue } from '../utils/dates'
import {
  METHODOLOGY,
  blackFridayLabel,
  formatCount,
  formatCurrency,
  formatPct,
  formatSigned,
  savingLabel,
  savingTone,
} from '../utils/savings'
import { useFillOrigin } from '../utils/useFillOrigin'
import '../styles/materials.css'
import '../components/FillButton.css'
import '../components/CrudTable.css'
import './EconomiaPage.css'

type FormTarget = { kind: 'create'; draft: PurchaseDraft } | { kind: 'edit'; purchase: Purchase; label: string | null }

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function dayOf(iso: string): string {
  return parseApiDate(iso).toLocaleDateString('pt-BR')
}

function priceRange(item: ReportItem): string {
  const savings = item.savings
  if (savings === null || savings.status !== 'ok') return '—'
  if (savings.lowest_seen_cents === null || savings.highest_seen_cents === null) return '—'
  return `${formatCurrency(savings.lowest_seen_cents)} – ${formatCurrency(savings.highest_seen_cents)}`
}

export function EconomiaPage() {
  const { csrfToken } = useAuth()
  const fillOrigin = useFillOrigin()
  const navigate = useNavigate()
  const location = useLocation()
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [report, setReport] = useState<SavingsReport | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [blackFriday, setBlackFriday] = useState('')
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Purchase | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showCard, setShowCard] = useState(false)

  const reload = useCallback(() => {
    Promise.all([listPurchases(), fetchSavingsReport(blackFriday || undefined)])
      .then(([purchaseRows, reportData]) => {
        setPurchases(purchaseRows)
        setReport(reportData)
        setListError(null)
      })
      .catch(() => setListError('Não foi possível carregar o relatório de economia.'))
      .finally(() => setLoading(false))
  }, [blackFriday])

  useEffect(reload, [reload])

  useEffect(() => {
    listRules(true)
      .then(setRules)
      .catch(() => setRules([]))
  }, [])

  // "Marcar como comprado" (card / product panel) lands here with the form pre-filled.
  useEffect(() => {
    const state = location.state as EconomiaNavState | null
    if (state?.prefill) {
      setFormTarget({ kind: 'create', draft: state.prefill })
      setFormError(null)
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location.pathname, location.state, navigate])

  const search = useCallback(
    async (query: string): Promise<LinkOption[]> => {
      const needle = normalize(query)
      const ruleOptions: LinkOption[] = rules
        .filter((rule) => normalize(rule.name).includes(needle))
        .slice(0, 4)
        .map((rule) => ({ kind: 'rule', productKey: null, ruleId: rule.id, label: rule.name }))
      const matches = await fetchMatches({ search: query })
      const seen = new Set<string>()
      const productOptions: LinkOption[] = []
      for (const match of matches) {
        if (match.product_key === null || seen.has(match.product_key)) continue
        seen.add(match.product_key)
        const rule = rules.find((candidate) => candidate.id === match.rule_id)
        const label = (match as { display_name?: string | null }).display_name ?? cardTitle(match.message_text, rule)
        productOptions.push({ kind: 'product', productKey: match.product_key, ruleId: null, label })
        if (productOptions.length >= 6) break
      }
      return [...ruleOptions, ...productOptions]
    },
    [rules],
  )

  const openCreate = () => {
    setFormTarget({ kind: 'create', draft: EMPTY_DRAFT })
    setFormError(null)
  }

  const openEdit = (purchase: Purchase) => {
    setFormTarget({ kind: 'edit', purchase, label: null })
    setFormError(null)
    const rule = rules.find((candidate) => candidate.id === purchase.rule_id)
    if (purchase.product_key !== null) {
      fetchProduct(purchase.product_key, '7d')
        .then((product) =>
          setFormTarget((current) =>
            current?.kind === 'edit' && current.purchase.id === purchase.id
              ? { ...current, label: product.title }
              : current,
          ),
        )
        .catch(() => undefined)
    } else if (rule) {
      setFormTarget({ kind: 'edit', purchase, label: rule.name })
    }
  }

  const closeForm = () => {
    setFormTarget(null)
    setFormError(null)
  }

  const submitForm = (input: PurchaseInput) => {
    if (formTarget === null) return
    if (csrfToken === null) {
      setFormError(CSRF_MISSING_MESSAGE)
      return
    }
    setSubmitting(true)
    setFormError(null)
    const request =
      formTarget.kind === 'create'
        ? createPurchase(csrfToken, input)
        : updatePurchase(csrfToken, formTarget.purchase.id, input)
    request
      .then(() => {
        closeForm()
        reload()
      })
      .catch((error: unknown) =>
        reportFailure(
          error,
          error instanceof ApiError ? error.message : 'Não foi possível salvar a compra.',
          setFormError,
        ),
      )
      .finally(() => setSubmitting(false))
  }

  const confirmDelete = () => {
    if (pendingDelete === null) return
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      setPendingDelete(null)
      return
    }
    setDeleting(true)
    deletePurchase(csrfToken, pendingDelete.id)
      .then(() => {
        setPendingDelete(null)
        reload()
      })
      .catch((error: unknown) => {
        setPendingDelete(null)
        reportFailure(error, 'Não foi possível excluir a compra.', setListError)
      })
      .finally(() => setDeleting(false))
  }

  const purchaseById = useMemo(() => new Map(purchases.map((purchase) => [purchase.id, purchase])), [purchases])
  const formInitial = useMemo(() => {
    if (formTarget === null) return null
    if (formTarget.kind === 'create') {
      return valuesFromDraft(formTarget.draft, toDateInputValue(new Date()))
    }
    const { purchase } = formTarget
    return valuesFromDraft(
      {
        name: purchase.name,
        priceCents: purchase.price_cents,
        productKey: purchase.product_key,
        ruleId: purchase.rule_id,
        linkLabel: formTarget.label ?? (purchase.product_key === null && purchase.rule_id === null ? null : purchase.product_key),
      },
      apiDateToInput(purchase.purchased_at),
      purchase.store ?? '',
    )
  }, [formTarget])

  const totals = report?.totals
  const bf = report?.black_friday
  const tone = totals && totals.linked_with_data > 0 ? (totals.estimated_saving_cents < 0 ? 'bad' : 'good') : 'none'

  return (
    <main className="economia-page">
      <div className="economia-page__header">
        <div>
          <h1>Economia</h1>
          <p className="economia-page__subtitle">
            O que você comprou e quanto o teleyes ajudou a pagar menos.
          </p>
        </div>
        <div className="economia-page__header-actions">
          <button type="button" className="plane-action fill-button" onClick={openCreate} onPointerDown={fillOrigin}>
            Registrar compra
          </button>
          <button
            type="button"
            className="plane-action plane-action--secondary"
            onClick={() => setShowCard((open) => !open)}
            disabled={report === null || report.totals.purchases === 0}
          >
            Gerar cartão de resultados
          </button>
        </div>
      </div>

      {formTarget && formInitial && (
        <PurchaseForm
          key={formTarget.kind === 'edit' ? `edit-${formTarget.purchase.id}-${formTarget.label ?? ''}` : 'create'}
          title={formTarget.kind === 'create' ? 'Registrar compra' : 'Editar compra'}
          initial={formInitial}
          submitting={submitting}
          error={formError}
          onSearch={search}
          onSubmit={submitForm}
          onCancel={closeForm}
        />
      )}

      {loading && <p>Carregando…</p>}
      {listError && (
        <p role="alert" className="economia-page__error">
          {listError}
        </p>
      )}

      {report && totals && bf && (
        <>
          <section className="economia-tiles" aria-label="Resumo">
            <div className="plane-pearl economia-tile">
              <div className="economia-tile__label">Total pago</div>
              <div className="economia-tile__value">{formatCurrency(totals.total_paid_cents)}</div>
              <div className="economia-tile__detail">
                {totals.purchases} {totals.purchases === 1 ? 'compra' : 'compras'}
              </div>
            </div>
            <div className="plane-pearl economia-tile">
              <div className="economia-tile__label">Economia estimada</div>
              <div className={`economia-tile__value economia-tone--${tone}`}>
                {totals.linked_with_data > 0 ? formatSigned(totals.estimated_saving_cents) : 'sem dados'}
              </div>
              <div className="economia-tile__detail">
                {totals.linked_with_data > 0
                  ? `${totals.estimated_saving_pct === null ? '' : `${formatPct(totals.estimated_saving_pct)} vs. mediana · `}${totals.linked_with_data} de ${totals.purchases} com histórico`
                  : 'Vincule compras a produtos para estimar'}
              </div>
            </div>
            <div className="plane-pearl economia-tile">
              <div className="economia-tile__label">Antes da Black Friday</div>
              <div className="economia-tile__value">
                {bf.days_before_min === null || bf.days_before_max === null
                  ? '—'
                  : bf.days_before_min === bf.days_before_max
                    ? blackFridayLabel(bf.days_before_min)
                    : `${bf.days_before_min}–${bf.days_before_max} dias antes`}
              </div>
              <label className="economia-tile__detail economia-tile__bf">
                Black Friday
                <input
                  type="date"
                  aria-label="Data da Black Friday"
                  value={blackFriday || bf.date}
                  onChange={(event) => setBlackFriday(event.target.value)}
                />
                {blackFriday !== '' && (
                  <button type="button" onClick={() => setBlackFriday('')}>
                    Usar padrão
                  </button>
                )}
              </label>
            </div>
          </section>

          <p className="economia-page__method">{METHODOLOGY}</p>

          <section className="plane-pearl economia-table-wrap" aria-label="Compras">
            <table className="crud-table">
              <thead>
                <tr>
                  <th>Peça</th>
                  <th>Pago</th>
                  <th>Mediana 90d</th>
                  <th>Economia estimada</th>
                  <th>Menor – maior visto</th>
                  <th>Data</th>
                  <th>Black Friday</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((item) => {
                  const purchase = purchaseById.get(item.id)
                  const toneClass = `economia-tone--${savingTone(item.savings)}`
                  return (
                    <tr key={item.id}>
                      <td className="crud-table__name" data-label="Peça">
                        {item.name}
                        {item.store && <div className="economia-table__store">{item.store}</div>}
                      </td>
                      <td data-label="Pago">{formatCurrency(item.price_cents)}</td>
                      <td data-label="Mediana 90d">
                        {item.savings?.status === 'ok' && item.savings.median_90d_cents !== null
                          ? formatCurrency(item.savings.median_90d_cents)
                          : '—'}
                      </td>
                      <td data-label="Economia estimada" className={toneClass}>
                        {savingLabel(item.savings)}
                      </td>
                      <td data-label="Menor – maior visto">{priceRange(item)}</td>
                      <td data-label="Data">{dayOf(item.purchased_at)}</td>
                      <td data-label="Black Friday">{blackFridayLabel(item.days_before_black_friday)}</td>
                      <td className="crud-table__actions" data-label="Ações">
                        <button type="button" onClick={() => purchase && openEdit(purchase)} disabled={!purchase}>
                          Editar
                        </button>
                        <button
                          type="button"
                          className="crud-table__actions--danger"
                          onClick={() => purchase && setPendingDelete(purchase)}
                          disabled={!purchase}
                        >
                          Excluir
                        </button>
                      </td>
                    </tr>
                  )
                })}
                {report.items.length === 0 && (
                  <tr>
                    <td colSpan={8}>
                      Nenhuma compra registrada ainda. Use “Registrar compra” ou “Marcar como comprado” em um card
                      do Feed.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="plane-pearl economia-noise" aria-label="Ruído evitado">
            <h2>Ruído evitado</h2>
            <p className="economia-noise__sub">
              Só contadores agregados; o teleyes nunca guarda o texto do que descartou. As contagens de mensagens
              são acumuladas desde o início do monitoramento.
            </p>
            <dl className="economia-noise__grid">
              <div>
                <dt>Mensagens analisadas</dt>
                <dd>{formatCount(report.noise.messages_analyzed)}</dd>
              </div>
              <div>
                <dt>Descartadas</dt>
                <dd>
                  {formatCount(
                    report.noise.discarded.sem_termo +
                      report.noise.discarded.bloqueado +
                      report.noise.discarded.preco_acima_teto,
                  )}
                </dd>
                <dd className="economia-noise__detail">
                  {formatCount(report.noise.discarded.sem_termo)} sem termo ·{' '}
                  {formatCount(report.noise.discarded.bloqueado)} bloqueadas ·{' '}
                  {formatCount(report.noise.discarded.preco_acima_teto)} acima do teto
                </dd>
              </div>
              <div>
                <dt>Repetidos agrupados</dt>
                <dd>{formatCount(report.noise.duplicates_grouped)}</dd>
              </div>
              <div>
                <dt>Alertas enviados</dt>
                <dd>{formatCount(report.noise.alerts_sent)}</dd>
                <dd className="economia-noise__detail">de {formatCount(report.noise.alerts_matched)} ofertas no período</dd>
              </div>
            </dl>
          </section>

          {showCard && <ResultsCardPanel report={report} onClose={() => setShowCard(false)} />}
        </>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Excluir compra?"
          message={`“${pendingDelete.name}” sai da lista e do relatório. Isso não pode ser desfeito.`}
          confirmLabel="Excluir compra"
          busy={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </main>
  )
}
