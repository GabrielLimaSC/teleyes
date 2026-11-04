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
  deleteSavingsGoal,
  fetchSavingsReport,
  listPurchases,
  saveSavingsGoal,
  updatePurchase,
} from '../api/purchases'
import type { Purchase, PurchaseInput, SavingsGoalInput, SavingsReport } from '../api/purchases'
import { listRules } from '../api/rules'
import type { Rule } from '../api/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { RowActionsMenu } from '../components/RowActionsMenu'
import { cardTitle } from '../components/matchTitle'
import { EmptyState } from '../components/EmptyState'
import { FirstTimeTip } from '../components/FirstTimeTip'
import { EMPTY_DRAFT, valuesFromDraft } from '../economia/purchaseDraft'
import type { EconomiaNavState, LinkOption, PurchaseDraft } from '../economia/purchaseDraft'
import { PurchaseForm } from '../economia/PurchaseForm'
import { PriceRangeBar } from '../economia/PriceRangeBar'
import { ReferenceMarker } from '../economia/ReferenceMarker'
import { ResultsCardPanel } from '../economia/ResultsCardPanel'
import { GoalCard, GoalDialog } from '../economia/GoalCard'
import { PaidCard, SavingsCard } from '../economia/SummaryCards'
import { apiDateToInput, parseApiDate, toDateInputValue } from '../utils/dates'
import {
  formatCount,
  formatCurrency,
  historyOrigin,
  referencePill,
  savingPill,
  savingTone,
} from '../utils/savings'
import { useFillOrigin } from '../utils/useFillOrigin'
import '../styles/materials.css'
import '../components/FillButton.css'
import '../components/CrudTable.css'
import './EconomiaPage.css'

type FormTarget =
  | { kind: 'create'; draft: PurchaseDraft }
  | { kind: 'edit'; purchase: Purchase; label: string | null; focusLink?: boolean }

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function dayMonth(iso: string): string {
  return parseApiDate(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

/** "+8,3%" / "−2,0%" of the goal; the sign matters (an overpayment subtracts). */
function shareLabel(share: number): string {
  const text = `${Math.abs(share).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
  return share > 0 ? `+${text}` : share < 0 ? `−${text}` : text
}

export function EconomiaPage() {
  const { csrfToken } = useAuth()
  const fillOrigin = useFillOrigin()
  const navigate = useNavigate()
  const location = useLocation()
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [report, setReport] = useState<SavingsReport | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [goalDialog, setGoalDialog] = useState(false)
  const [goalSaving, setGoalSaving] = useState(false)
  const [goalError, setGoalError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Purchase | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showCard, setShowCard] = useState(false)

  const reload = useCallback(() => {
    Promise.all([listPurchases(), fetchSavingsReport()])
      .then(([purchaseRows, reportData]) => {
        setPurchases(purchaseRows)
        setReport(reportData)
        setListError(null)
      })
      .catch(() => setListError('Não foi possível carregar o relatório de economia.'))
      .finally(() => setLoading(false))
  }, [])

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

  const openEdit = (purchase: Purchase, focusLink = false) => {
    setFormTarget({ kind: 'edit', purchase, label: null, focusLink })
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
      setFormTarget({ kind: 'edit', purchase, label: rule.name, focusLink })
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

  const closeGoal = () => {
    setGoalDialog(false)
    setGoalError(null)
  }

  const submitGoal = (input: SavingsGoalInput) => {
    if (csrfToken === null) {
      setGoalError(CSRF_MISSING_MESSAGE)
      return
    }
    setGoalSaving(true)
    setGoalError(null)
    saveSavingsGoal(csrfToken, input)
      .then(() => {
        closeGoal()
        reload()
      })
      .catch((error: unknown) =>
        reportFailure(
          error,
          error instanceof ApiError ? error.message : 'Não foi possível salvar a meta.',
          setGoalError,
        ),
      )
      .finally(() => setGoalSaving(false))
  }

  const removeGoal = () => {
    if (csrfToken === null) {
      setGoalError(CSRF_MISSING_MESSAGE)
      return
    }
    setGoalSaving(true)
    deleteSavingsGoal(csrfToken)
      .then(() => {
        closeGoal()
        reload()
      })
      .catch((error: unknown) => reportFailure(error, 'Não foi possível remover a meta.', setGoalError))
      .finally(() => setGoalSaving(false))
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
      { cents: purchase.reference_price_cents, note: purchase.reference_note },
    )
  }, [formTarget])

  const totals = report?.totals
  const goal = report?.goal ?? null

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
          <button
            type="button"
            className="plane-action plane-action--secondary"
            onClick={() => setShowCard((open) => !open)}
            disabled={report === null || report.totals.purchases === 0}
          >
            Gerar cartão de resultados
          </button>
          <button type="button" className="plane-action fill-button" onClick={openCreate} onPointerDown={fillOrigin}>
            <span aria-hidden="true" className="economia-page__plus">+</span>
            Registrar compra
          </button>
        </div>
      </div>

      <FirstTimeTip id="economia">
        Registre o que você comprou e veja quanto economizou em relação ao preço que o teleyes viu para o mesmo produto.
      </FirstTimeTip>

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
          focusLink={formTarget.kind === 'edit' && formTarget.focusLink === true}
        />
      )}

      {loading && <p>Carregando…</p>}
      {listError && (
        <p role="alert" className="economia-page__error">
          {listError}
        </p>
      )}

      {report && totals && (
        <>
          <section className="economia-tiles" aria-label="Resumo">
            <SavingsCard report={report} />
            <PaidCard report={report} />
            <GoalCard
              goal={goal}
              onDefine={() => setGoalDialog(true)}
              onEdit={() => setGoalDialog(true)}
            />
          </section>

          <section className="plane-pearl economia-table-wrap" aria-label="Compras">
            <div className="economia-table__head">
              <h2>Compras</h2>
              <ul className="economia-legend" aria-label="Legenda">
                <li>
                  <span className="economia-legend__range" aria-hidden="true" />
                  menor–maior visto 90d
                </li>
                <li>
                  <span className="economia-legend__median" aria-hidden="true" />
                  mediana
                </li>
                <li>
                  <span className="economia-legend__paid" aria-hidden="true" />
                  você pagou
                </li>
              </ul>
            </div>
            <table className="economia-table">
              <thead>
                <tr>
                  <th>Peça</th>
                  <th className="economia-table__num">Pago</th>
                  <th>Onde o preço caiu na faixa vista</th>
                  <th>Economia</th>
                  {goal && <th className="economia-table__num">Parte da meta</th>}
                  <th>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((item) => {
                  const purchase = purchaseById.get(item.id)
                  const tone = savingTone(item.savings)
                  const pill = savingPill(item.savings)
                  const origin = historyOrigin(item)
                  const reference = item.reference ?? null
                  const noHistory = pill === 'sem histórico'
                  return (
                    <tr key={item.id}>
                      <td className="economia-table__piece" data-label="Peça">
                        <div className="economia-table__name">{item.name}</div>
                        <div className="economia-table__store">
                          {[item.store, dayMonth(item.purchased_at)].filter(Boolean).join(' · ')}
                        </div>
                        {origin && <div className="economia-table__origin">{origin}</div>}
                      </td>
                      <td className="economia-table__num" data-label="Pago">
                        {formatCurrency(item.price_cents)}
                      </td>
                      <td className="economia-table__range" data-label="Faixa vista">
                        {reference ? <ReferenceMarker item={item} /> : <PriceRangeBar item={item} />}
                      </td>
                      <td data-label="Economia">
                        {reference ? (
                          <span className="economia-pill economia-pill--reference">
                            {referencePill(reference)}
                            <span className="economia-pill__tag">pela sua referência</span>
                          </span>
                        ) : noHistory && purchase && item.link_kind == null ? (
                          <button
                            type="button"
                            className="economia-pill economia-pill--action"
                            onClick={() => openEdit(purchase, true)}
                          >
                            Vincular regra
                          </button>
                        ) : (
                          <span className={`economia-pill economia-pill--${tone}`}>{pill}</span>
                        )}
                      </td>
                      {goal && (
                        <td className="economia-table__num" data-label="Parte da meta">
                          {item.share_of_goal == null ? '—' : shareLabel(item.share_of_goal)}
                        </td>
                      )}
                      <td className="economia-table__actions">
                        {purchase && (
                          <RowActionsMenu
                            label={`Mais ações da compra ${item.name}`}
                            items={[
                              { key: 'edit', label: 'Editar', onSelect: () => openEdit(purchase) },
                              { key: 'delete', label: 'Excluir', danger: true, onSelect: () => setPendingDelete(purchase) },
                            ]}
                          />
                        )}
                      </td>
                    </tr>
                  )
                })}
                {report.items.length === 0 && (
                  <tr>
                    <td colSpan={goal ? 6 : 5} className="economia-table__empty">
                      <EmptyState
                        title="Nenhuma compra registrada"
                        text="Aqui você vê quanto pagou a menos que o preço visto pelo teleyes. Registre uma compra aqui ou use “Marcar como comprado” num card das Ofertas."
                        action={{ label: 'Registrar primeira compra', onClick: openCreate }}
                      />
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
                  {formatCount(report.noise.discarded.preco_acima_teto)} acima do preço máximo
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

      {goalDialog && (
        <GoalDialog
          current={goal}
          submitting={goalSaving}
          error={goalError}
          onSubmit={submitGoal}
          onRemove={removeGoal}
          onCancel={closeGoal}
        />
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
