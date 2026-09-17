import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import { clearRuleMatches, createRule, deleteRule, listRules, pauseRule, updateRule } from '../api/rules'
import type { RuleInput } from '../api/rules'
import { fetchMatches } from '../api/matches'
import { ApiError } from '../api/auth'
import type { Rule } from '../api/types'
import { previewRuleMatch } from '../utils/ruleMatchPreview'
import { StatusToggle } from '../components/StatusToggle'
import { Toast } from '../components/Toast'
import { useToast } from '../hooks/useToast'
import { useFillOrigin } from '../utils/useFillOrigin'
import { DestinatariosSection } from './DestinatariosSection'
import '../components/GlassCard.css'
import '../components/CrudTable.css'
import '../components/FillButton.css'

interface RuleForm {
  name: string
  includeTerms: string
  excludeTerms: string
  maxPriceReais: string
}

const EMPTY_FORM: RuleForm = { name: '', includeTerms: '', excludeTerms: '', maxPriceReais: '' }

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

  const [formTarget, setFormTarget] = useState<FormTarget | null>(null)
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [pausingId, setPausingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const [testerId, setTesterId] = useState<number | null>(null)
  const [testerText, setTesterText] = useState('')

  const [checkingClearId, setCheckingClearId] = useState<number | null>(null)
  const [clearConfirm, setClearConfirm] = useState<{ rule: Rule; count: number } | null>(null)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)

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

  useEffect(reload, [])

  const openCreate = () => {
    setFormTarget({ kind: 'create' })
    setForm(EMPTY_FORM)
    setFormError(null)
  }

  const openEdit = (rule: Rule) => {
    setFormTarget({ kind: 'edit', rule })
    setForm(ruleToForm(rule, { asCopy: false }))
    setFormError(null)
  }

  const openDuplicate = (rule: Rule) => {
    setFormTarget({ kind: 'create' })
    setForm(ruleToForm(rule, { asCopy: true }))
    setFormError(null)
  }

  const closeForm = () => {
    setFormTarget(null)
    setFormError(null)
  }

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (formTarget === null) return
    if (csrfToken === null) {
      setFormError(CSRF_MISSING_MESSAGE)
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
        closeForm()
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

  return (
    <main className="crud-page">
      <div className="crud-page__header">
        <h1>Regras</h1>
        <button
          type="button"
          className="crud-page__new-button fill-button"
          onClick={openCreate}
          onPointerDown={fillOrigin}
        >
          + Nova regra
        </button>
      </div>

      {formTarget && (
        <form className="glass-card crud-form" onSubmit={submitForm}>
          <h2>{formTarget.kind === 'create' ? 'Nova regra' : 'Editar regra'}</h2>
          <div className="crud-form__grid">
            <label>
              Nome
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
              />
            </label>
            <label>
              Termos incluídos (separados por vírgula)
              <input
                value={form.includeTerms}
                onChange={(event) => setForm({ ...form, includeTerms: event.target.value })}
                required
              />
            </label>
            <label>
              Termos bloqueados
              <input
                value={form.excludeTerms}
                onChange={(event) => setForm({ ...form, excludeTerms: event.target.value })}
              />
            </label>
            <label>
              Preço máximo (R$)
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.maxPriceReais}
                onChange={(event) => setForm({ ...form, maxPriceReais: event.target.value })}
              />
            </label>
          </div>
          <div className="crud-form__actions">
            <button
              type="submit"
              className="crud-form__submit fill-button"
              disabled={submitting}
              onPointerDown={fillOrigin}
            >
              {submitting ? 'Salvando…' : 'Salvar'}
            </button>
            <button type="button" className="crud-form__cancel" onClick={closeForm}>
              Cancelar
            </button>
          </div>
          {formError && (
            <p role="alert" className="crud-form__error">
              {formError}
            </p>
          )}
        </form>
      )}

      {loading && <p>Carregando…</p>}
      {listError && (
        <p role="alert" className="crud-page__error">
          {listError}
        </p>
      )}

      {!loading && !listError && (
        <>
          {/* S10-07: section header above the table (S10-05 comp's
              `.section-row`) — only position/structure, table itself
              unchanged. */}
          <div className="crud-section-row">
            <h2>Regras cadastradas</h2>
            <p>
              {rules.length === 1 ? '1 regra' : `${rules.length} regras`} · ações disponíveis em
              cada linha
            </p>
          </div>
          <div className="glass-card crud-table-wrap">
            <table className="crud-table">
              <thead>
                <tr>
                  <th>Regra</th>
                  <th>Termos incluídos</th>
                  <th>Termos bloqueados</th>
                  <th>Preço máximo</th>
                  <th>Menor preço já visto</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td className="crud-table__name" data-label="Regra">
                      {rule.name}
                    </td>
                    <td data-label="Termos incluídos">{rule.include_terms}</td>
                    <td data-label="Termos bloqueados">{rule.exclude_terms ?? '—'}</td>
                    <td data-label="Preço máximo">{formatPriceLimit(rule.max_price_cents)}</td>
                    <td data-label="Menor preço já visto">
                      {formatLowestPrice(rule.lowest_price_cents)}
                    </td>
                    <td data-label="Status">
                      <StatusToggle
                        active={rule.active}
                        pausing={pausingId === rule.id}
                        onPause={() => handlePause(rule)}
                      />
                    </td>
                    <td className="crud-table__actions" data-label="Ações">
                      <button type="button" onClick={() => openEdit(rule)}>
                        Editar
                      </button>
                      <button type="button" onClick={() => openDuplicate(rule)}>
                        Duplicar
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setTesterId(testerId === rule.id ? null : rule.id)
                          setTesterText('')
                        }}
                      >
                        Testar
                      </button>
                      <button
                        type="button"
                        className="crud-table__actions--danger"
                        onClick={() => openClearConfirm(rule)}
                        disabled={checkingClearId === rule.id}
                      >
                        {checkingClearId === rule.id ? 'Checando…' : 'Limpar histórico'}
                      </button>
                      <button
                        type="button"
                        className="crud-table__actions--danger"
                        onClick={() => handleDelete(rule)}
                        disabled={deletingId === rule.id}
                      >
                        Excluir
                      </button>
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
        </>
      )}

      {activeTester && (
        <div className="glass-card crud-form" style={{ marginTop: 'var(--space-4)' }}>
          <h2>Testar regra: {activeTester.name}</h2>
          {/* S9-01/S9-02 drive-by: was a hardcoded #4b4b52/13px, missed in
              the S9-01 CSS-file sweep since this one's an inline style. */}
          <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-helper)' }}>
            Prévia local (não chama a API nem cria dado nenhum) — reproduz a mesma lógica de
            normalização e termos do backend.
          </p>
          <label>
            Mensagem de exemplo
            <input value={testerText} onChange={(event) => setTesterText(event.target.value)} />
          </label>
          {testerText.trim() !== '' && (
            <p style={{ fontWeight: 600 }}>
              {previewRuleMatch(testerText, activeTester.include_terms, activeTester.exclude_terms)
                ? '✅ Bateria com esta regra'
                : '❌ Não bateria com esta regra'}
            </p>
          )}
        </div>
      )}

      {clearConfirm && (
        <div className="glass-card crud-form" style={{ marginTop: 'var(--space-4)' }}>
          <h2>Limpar histórico: {clearConfirm.rule.name}</h2>
          <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-helper)' }}>
            Isso apaga{' '}
            {clearConfirm.count === 1 ? '1 match' : `${clearConfirm.count} matches`} desta
            regra (e as entregas registradas neles) do Feed/Histórico — a regra em si continua
            ativa e pronta pra gerar matches novos. Essa ação não pode ser desfeita.
          </p>
          <div className="crud-form__actions">
            <button
              type="button"
              className="crud-form__submit fill-button"
              onClick={confirmClear}
              disabled={clearing}
              onPointerDown={fillOrigin}
            >
              {clearing ? 'Apagando…' : 'Apagar histórico'}
            </button>
            <button type="button" className="crud-form__cancel" onClick={closeClearConfirm}>
              Cancelar
            </button>
          </div>
          {clearError && (
            <p role="alert" className="crud-form__error">
              {clearError}
            </p>
          )}
        </div>
      )}

      <DestinatariosSection />
      <Toast toast={toast} onDismiss={dismiss} />
    </main>
  )
}
