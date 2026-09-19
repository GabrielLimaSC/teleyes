import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import { clearRuleMatches, createRule, deleteRule, listRules, pauseRule, updateRule } from '../api/rules'
import type { RuleInput } from '../api/rules'
import { fetchMatches } from '../api/matches'
import { fetchMetrics } from '../api/metrics'
import { ApiError } from '../api/auth'
import type { Rule } from '../api/types'
import { previewRuleMatch } from '../utils/ruleMatchPreview'
import { parseTermList } from '../utils/termList'
import { StatusToggle } from '../components/StatusToggle'
import { TermChipsInput } from '../components/TermChipsInput'
import { Toast } from '../components/Toast'
import { useToast } from '../hooks/useToast'
import { useFillOrigin } from '../utils/useFillOrigin'
import { DestinatariosSection } from './DestinatariosSection'
import '../components/CrudTable.css'
import '../components/FillButton.css'
import './RegrasPage.css'

interface RuleForm {
  name: string
  includeTerms: string
  excludeTerms: string
  maxPriceReais: string
}

const EMPTY_FORM: RuleForm = { name: '', includeTerms: '', excludeTerms: '', maxPriceReais: '' }

const NO_TERMS_MESSAGE = 'Informe ao menos um termo incluído.'

function ruleToForm(rule: Rule, { asCopy }: { asCopy: boolean }): RuleForm {
  return {
    name: asCopy ? `${rule.name} (cópia)` : rule.name,
    includeTerms: rule.include_terms,
    excludeTerms: rule.exclude_terms ?? '',
    maxPriceReais: rule.max_price_cents !== null ? String(rule.max_price_cents / 100) : '',
  }
}

function formToInput(form: RuleForm): RuleInput {
  return {
    name: form.name,
    include_terms: form.includeTerms,
    exclude_terms: form.excludeTerms.trim() === '' ? null : form.excludeTerms,
    max_price_cents: form.maxPriceReais.trim() === '' ? null : Math.round(Number(form.maxPriceReais) * 100),
  }
}

function formatPriceLimit(cents: number | null): string {
  if (cents === null) return 'Sem teto'
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatLowestPrice(cents: number | null): string {
  if (cents === null) return '—'
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

type FormTarget = { kind: 'create' } | { kind: 'edit'; rule: Rule }

export function RegrasPage() {
  const { csrfToken } = useAuth()
  const fillOrigin = useFillOrigin()
  const { toast, showToast, dismiss } = useToast()
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  // S11-05: the form is a permanent rail beside the table, not a panel that
  // opens above it — `create` is its resting state, Editar/Duplicar load a
  // rule into it. `formVersion` remounts the chips input on every load so a
  // half-typed term never leaks from one rule into the next.
  const [formTarget, setFormTarget] = useState<FormTarget>({ kind: 'create' })
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM)
  const [formVersion, setFormVersion] = useState(0)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const [pausingId, setPausingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const [testerId, setTesterId] = useState<number | null>(null)
  const [testerText, setTesterText] = useState('')

  const [checkingClearId, setCheckingClearId] = useState<number | null>(null)
  const [clearConfirm, setClearConfirm] = useState<{ rule: Rule; count: number } | null>(null)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)

  // `null` = not loaded (or failed to load) — the panel shows "—", never a
  // made-up zero.
  const [matchedCount, setMatchedCount] = useState<number | null>(null)
  const [ceilingDiscards, setCeilingDiscards] = useState<number | null>(null)

  const reload = () => {
    setLoading(true)
    listRules(true)
      .then((data) => {
        setRules(data)
        setListError(null)
      })
      .catch(() => setListError('Não foi possível carregar as regras.'))
      .finally(() => setLoading(false))
  }

  // S11-05: both numbers are system-wide and cumulative — `GET /matches`
  // returns every stored match (grouped duplicates collapsed, same count the
  // Feed shows) and `GET /metrics` is a since-forever counter with no
  // per-rule or per-period breakdown, so the panel labels them as such
  // instead of implying "hoje" or a per-rule figure.
  const loadStats = () => {
    fetchMatches()
      .then((matches) => setMatchedCount(matches.length))
      .catch(() => setMatchedCount(null))
    fetchMetrics()
      .then((counters) =>
        setCeilingDiscards(
          counters
            .filter((counter) => counter.reason === 'preco_acima_teto')
            .reduce((sum, counter) => sum + counter.count, 0),
        ),
      )
      .catch(() => setCeilingDiscards(null))
  }

  useEffect(reload, [])
  useEffect(loadStats, [])

  const loadForm = (target: FormTarget, next: RuleForm) => {
    setFormTarget(target)
    setForm(next)
    setFormVersion((version) => version + 1)
    setFormError(null)
  }

  const openCreate = () => {
    loadForm({ kind: 'create' }, EMPTY_FORM)
    nameInputRef.current?.focus()
  }

  const openEdit = (rule: Rule) => {
    loadForm({ kind: 'edit', rule }, ruleToForm(rule, { asCopy: false }))
    nameInputRef.current?.focus()
  }

  const openDuplicate = (rule: Rule) => {
    loadForm({ kind: 'create' }, ruleToForm(rule, { asCopy: true }))
    nameInputRef.current?.focus()
  }

  const resetForm = () => loadForm({ kind: 'create' }, EMPTY_FORM)

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (csrfToken === null) {
      setFormError(CSRF_MISSING_MESSAGE)
      return
    }
    if (parseTermList(form.includeTerms).length === 0) {
      setFormError(NO_TERMS_MESSAGE)
      return
    }
    setSubmitting(true)
    setFormError(null)
    const input = formToInput(form)
    const request =
      formTarget.kind === 'create'
        ? createRule(csrfToken, input)
        : updateRule(csrfToken, formTarget.rule.id, input)

    const wasCreate = formTarget.kind === 'create'
    request
      .then(() => {
        resetForm()
        reload()
        showToast(wasCreate ? 'Regra criada.' : 'Regra atualizada.')
      })
      .catch((error: unknown) => {
        setFormError(error instanceof ApiError ? error.message : 'Não foi possível salvar a regra.')
      })
      .finally(() => setSubmitting(false))
  }

  const handlePause = (rule: Rule) => {
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    setPausingId(rule.id)
    pauseRule(csrfToken, rule.id)
      .then(() => {
        reload()
        showToast('Regra pausada.')
      })
      .catch(() => setListError('Não foi possível pausar a regra.'))
      .finally(() => setPausingId(null))
  }

  const handleDelete = (rule: Rule) => {
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    setDeletingId(rule.id)
    deleteRule(csrfToken, rule.id)
      .then(() => {
        reload()
        showToast('Regra excluída.')
      })
      .catch((error: unknown) => {
        setListError(error instanceof ApiError ? error.message : 'Não foi possível excluir a regra.')
      })
      .finally(() => setDeletingId(null))
  }

  // S10-04: the count shown here is the same one Feed/Histórico would show
  // for this rule (grouped duplicate cards collapsed) — meaningful to
  // Gabriel as "how many cards go away", even on the rare message where a
  // few of those matches are folded duplicates and the real row count the
  // backend deletes ends up slightly higher (reflected in the success
  // toast afterward, which always uses the API's own real count).
  const openClearConfirm = (rule: Rule) => {
    setClearError(null)
    setCheckingClearId(rule.id)
    fetchMatches({ ruleId: rule.id })
      .then((matches) => {
        if (matches.length === 0) {
          showToast(`Nenhum match encontrado pra "${rule.name}".`)
          return
        }
        setClearConfirm({ rule, count: matches.length })
      })
      .catch(() => setListError('Não foi possível checar o histórico da regra.'))
      .finally(() => setCheckingClearId(null))
  }

  const closeClearConfirm = () => {
    setClearConfirm(null)
    setClearError(null)
  }

  const confirmClear = () => {
    if (clearConfirm === null) return
    if (csrfToken === null) {
      setClearError(CSRF_MISSING_MESSAGE)
      return
    }
    setClearing(true)
    clearRuleMatches(csrfToken, clearConfirm.rule.id)
      .then(({ deleted }) => {
        reload()
        loadStats()
        setClearConfirm(null)
        showToast(
          deleted === 1 ? '1 match apagado.' : `${deleted} matches apagados.`,
        )
      })
      .catch((error: unknown) => {
        setClearError(
          error instanceof ApiError ? error.message : 'Não foi possível limpar o histórico.',
        )
      })
      .finally(() => setClearing(false))
  }

  const activeTester = rules.find((rule) => rule.id === testerId)
  const isEditing = formTarget.kind === 'edit'

  return (
    <main className="crud-page regras-page">
      <div className="regras-page__header">
        <div>
          <h1>Regras</h1>
          {!loading && !listError && (
            <p className="regras-page__subtitle">
              {rules.length === 1 ? '1 regra' : `${rules.length} regras`} · ações disponíveis em
              cada linha
            </p>
          )}
        </div>
        <button
          type="button"
          className="plane-action fill-button regras-page__new-button"
          onClick={openCreate}
          onPointerDown={fillOrigin}
        >
          + Nova regra
        </button>
      </div>

      <div className="regras-page__grid">
        <div className="regras-page__main">
          {loading && <p>Carregando…</p>}
          {listError && (
            <p role="alert" className="crud-page__error">
              {listError}
            </p>
          )}

          {!loading && !listError && (
            <div className="plane-pearl crud-table-wrap wide-table-wrap">
              <table className="crud-table wide-table">
                <thead>
                  <tr>
                    <th>Regra</th>
                    <th>Termos incluídos</th>
                    <th>Bloqueados</th>
                    <th className="wide-table__num">Preço máximo</th>
                    <th className="wide-table__num">Menor já visto</th>
                    <th>Status</th>
                    <th className="wide-table__num">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr
                      key={rule.id}
                      className={
                        formTarget.kind === 'edit' && formTarget.rule.id === rule.id
                          ? 'wide-table__row--editing'
                          : undefined
                      }
                    >
                      <td className="crud-table__name" data-label="Regra">
                        {rule.name}
                      </td>
                      <td className="wide-table__terms" data-label="Termos incluídos">
                        {rule.include_terms}
                      </td>
                      <td className="wide-table__terms" data-label="Termos bloqueados">
                        {rule.exclude_terms ?? '—'}
                      </td>
                      <td className="wide-table__num" data-label="Preço máximo">
                        {formatPriceLimit(rule.max_price_cents)}
                      </td>
                      <td className="wide-table__num" data-label="Menor preço já visto">
                        {formatLowestPrice(rule.lowest_price_cents)}
                      </td>
                      <td data-label="Status">
                        <StatusToggle
                          active={rule.active}
                          pausing={pausingId === rule.id}
                          onPause={() => handlePause(rule)}
                        />
                      </td>
                      <td className="wide-table__actions" data-label="Ações">
                        <div className="wide-table__actions-inner">
                          <button
                            type="button"
                            className="plane-action plane-action--secondary plane-action--compact"
                            onClick={() => openEdit(rule)}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className="plane-action plane-action--secondary plane-action--compact"
                            onClick={() => openDuplicate(rule)}
                          >
                            Duplicar
                          </button>
                          <button
                            type="button"
                            className="plane-action plane-action--secondary plane-action--compact"
                            onClick={() => {
                              setTesterId(testerId === rule.id ? null : rule.id)
                              setTesterText('')
                            }}
                          >
                            Testar
                          </button>
                          <button
                            type="button"
                            className="plane-action plane-action--danger plane-action--compact"
                            onClick={() => openClearConfirm(rule)}
                            disabled={checkingClearId === rule.id}
                          >
                            {checkingClearId === rule.id ? 'Checando…' : 'Limpar histórico'}
                          </button>
                          <button
                            type="button"
                            className="plane-action plane-action--danger plane-action--compact"
                            onClick={() => handleDelete(rule)}
                            disabled={deletingId === rule.id}
                          >
                            Excluir
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {rules.length === 0 && (
                    <tr>
                      <td colSpan={7}>Nenhuma regra cadastrada ainda.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {activeTester && (
            <div className="plane-pearl regras-panel">
              <h2>Testar regra: {activeTester.name}</h2>
              <p className="regras-panel__note">
                Prévia local (não chama a API nem cria dado nenhum) — reproduz a mesma lógica de
                normalização e termos do backend.
              </p>
              <label className="regras-panel__field">
                Mensagem de exemplo
                <input value={testerText} onChange={(event) => setTesterText(event.target.value)} />
              </label>
              {testerText.trim() !== '' && (
                <p className="regras-panel__verdict">
                  {previewRuleMatch(testerText, activeTester.include_terms, activeTester.exclude_terms)
                    ? '✅ Bateria com esta regra'
                    : '❌ Não bateria com esta regra'}
                </p>
              )}
            </div>
          )}

          {clearConfirm && (
            <div className="plane-pearl regras-panel">
              <h2>Limpar histórico: {clearConfirm.rule.name}</h2>
              <p className="regras-panel__note">
                Isso apaga{' '}
                {clearConfirm.count === 1 ? '1 match' : `${clearConfirm.count} matches`} desta
                regra (e as entregas registradas neles) do Feed/Histórico — a regra em si continua
                ativa e pronta pra gerar matches novos. Essa ação não pode ser desfeita.
              </p>
              <div className="regras-panel__actions">
                <button
                  type="button"
                  className="plane-action fill-button regras-panel__button"
                  onClick={confirmClear}
                  disabled={clearing}
                  onPointerDown={fillOrigin}
                >
                  {clearing ? 'Apagando…' : 'Apagar histórico'}
                </button>
                <button
                  type="button"
                  className="plane-action plane-action--secondary regras-panel__button"
                  onClick={closeClearConfirm}
                >
                  Cancelar
                </button>
              </div>
              {clearError && (
                <p role="alert" className="regras-panel__error">
                  {clearError}
                </p>
              )}
            </div>
          )}

          <DestinatariosSection />
        </div>

        <aside className="regras-page__rail">
          <form className="plane-glass regras-form" onSubmit={submitForm}>
            <h2 className="regras-rail__eyebrow">{isEditing ? 'Editar regra' : 'Nova regra'}</h2>
            <label className="regras-form__field">
              Nome
              <input
                ref={nameInputRef}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder='ex.: Monitor 27" 165Hz'
                required
              />
            </label>
            <TermChipsInput
              key={formVersion}
              id="rule-include-terms"
              label="Termos incluídos"
              value={form.includeTerms}
              onChange={(includeTerms) => setForm((current) => ({ ...current, includeTerms }))}
              helper="Enter ou vírgula pra adicionar."
            />
            <label className="regras-form__field">
              Termos bloqueados
              <input
                value={form.excludeTerms}
                onChange={(event) => setForm({ ...form, excludeTerms: event.target.value })}
                placeholder="usado, caixa aberta…"
              />
            </label>
            <label className="regras-form__field">
              Preço máximo (R$)
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.maxPriceReais}
                onChange={(event) => setForm({ ...form, maxPriceReais: event.target.value })}
                placeholder="sem teto"
              />
            </label>
            <div className="regras-form__actions">
              <button
                type="submit"
                className="plane-action fill-button regras-form__submit"
                disabled={submitting}
                onPointerDown={fillOrigin}
              >
                {submitting ? 'Salvando…' : isEditing ? 'Salvar alterações' : 'Criar regra'}
              </button>
              <button
                type="button"
                className="plane-action plane-action--secondary regras-form__cancel"
                onClick={resetForm}
              >
                {isEditing ? 'Cancelar' : 'Limpar campos'}
              </button>
            </div>
            {formError && (
              <p role="alert" className="regras-form__error">
                {formError}
              </p>
            )}
          </form>

          <section className="plane-pearl regras-how">
            <h2 className="regras-rail__eyebrow">Como uma regra casa</h2>
            <p className="regras-how__text">
              Basta um dos termos incluídos aparecer na mensagem; qualquer termo bloqueado descarta.
              Se o preço achado passa do teto da regra, a mensagem também é descartada.
            </p>
            <dl className="regras-how__stats">
              <div className="regras-how__stat">
                <dt>Casaram</dt>
                <dd>{matchedCount ?? '—'}</dd>
              </div>
              <div className="regras-how__stat">
                <dt>Descartadas por teto</dt>
                <dd>{ceilingDiscards ?? '—'}</dd>
              </div>
            </dl>
            <p className="regras-how__caption">
              Totais acumulados de todas as regras, desde o início — não são do dia.
            </p>
          </section>
        </aside>
      </div>
      <Toast toast={toast} onDismiss={dismiss} />
    </main>
  )
}
