import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import {
  clearRuleMatches,
  createRule,
  deleteRule,
  listRules,
  pauseRule,
  resumeRule,
  testRule,
  updateRule,
} from '../api/rules'
import type { RuleInput, RuleTestInput } from '../api/rules'
import { fetchMatches } from '../api/matches'
import { fetchMetrics } from '../api/metrics'
import { fetchRuleSuggestion } from '../api/products'
import { fetchDigestSettings, updateDigestSettings } from '../api/digest'
import { listSnoozes, reactivateSnooze, snoozeRule } from '../api/snoozes'
import { ApiError } from '../api/auth'
import { reportFailure } from '../api/demo'
import type { DigestSettings, Match, Recipient, Rule, RuleSuggestion, RuleTestResult, Snooze } from '../api/types'
import { previewRuleMatch, termsError } from '../utils/ruleMatchPreview'
import { parseOptionalPriceInput } from '../utils/priceInput'
import { parseTermList } from '../utils/termList'
import { formatDayMonth, formatMatchedAt, isLater } from '../utils/dates'
import { EmptyState } from '../components/EmptyState'
import { FirstTimeTip } from '../components/FirstTimeTip'
import { AnchoredPopover } from '../components/AnchoredPopover'
import { ListenerApplyControl } from '../components/ListenerApplyControl'
import { RuleHistoryChart } from '../components/RuleHistoryChart'
import { settledToast } from '../components/listenerState'
import { RowActionsMenu } from '../components/RowActionsMenu'
import { StatusToggle } from '../components/StatusToggle'
import { TermChipsInput } from '../components/TermChipsInput'
import { Toast } from '../components/Toast'
import { useListenerStatus } from '../hooks/useListenerStatus'
import { useToast } from '../hooks/useToast'
import { ruleTargetState } from '../utils/target'
import { useFillOrigin } from '../utils/useFillOrigin'
import { readFormModePreference, usesAdvancedFields, writeFormModePreference } from '../rules/formMode'
import type { RuleFormMode } from '../rules/formMode'
import { RULE_TEMPLATES } from '../rules/templates'
import { previewMessage, useRulePreview } from '../rules/useRulePreview'
import { DeliveryAdjustments } from './DeliveryAdjustments'
import { DestinatariosSection } from './DestinatariosSection'
import { RecipientRailForm } from './RecipientRailForm'
import type { RecipientFormTarget } from './RecipientRailForm'
import { Avatar } from './RecipientDeliveryParts'
import { initial, recipientsLabel, recipientsMissingRule } from './recipientDelivery'
import '../components/CrudTable.css'
import '../components/FillButton.css'
import './RegrasPage.css'

interface RuleForm {
  name: string
  includeTerms: string
  excludeTerms: string
  maxPriceReais: string
  targetPriceReais: string
}

const EMPTY_FORM: RuleForm = {
  name: '',
  includeTerms: '',
  excludeTerms: '',
  maxPriceReais: '',
  targetPriceReais: '',
}

const NO_TERMS_MESSAGE = 'Informe ao menos um termo incluído.'

function ruleToForm(rule: Rule, { asCopy }: { asCopy: boolean }): RuleForm {
  return {
    name: asCopy ? `${rule.name} (cópia)` : rule.name,
    includeTerms: rule.include_terms,
    excludeTerms: rule.exclude_terms ?? '',
    maxPriceReais: rule.max_price_cents !== null ? String(rule.max_price_cents / 100) : '',
    targetPriceReais:
      rule.target_price_cents !== null ? String(rule.target_price_cents / 100) : '',
  }
}

// S14-13: `parseOptionalPriceInput` replaces `Math.round(Number(x) * 100)` —
// that read the pt-BR thousands dot as a decimal point ("5.749" silently
// became 575 cents instead of 574900). `.cents` is `null` for both "left
// blank" and "unparseable" here; `submitForm` validates both fields with the
// same parser first and blocks the save with a visible pt-BR error before
// either of these ever runs on a malformed value.
function formToInput(form: RuleForm): RuleInput {
  return {
    name: form.name,
    include_terms: form.includeTerms,
    exclude_terms: form.excludeTerms.trim() === '' ? null : form.excludeTerms,
    max_price_cents: parseOptionalPriceInput(form.maxPriceReais).cents,
    target_price_cents: parseOptionalPriceInput(form.targetPriceReais).cents,
  }
}

/** S13-07: same conversion as `formToInput`, minus `name` — `POST /rules/test`
 * only ever needs the fields that affect matching, straight from whatever is
 * currently typed, saved or not. */
function formToTestInput(form: RuleForm): RuleTestInput {
  return {
    include_terms: form.includeTerms,
    exclude_terms: form.excludeTerms.trim() === '' ? null : form.excludeTerms,
    max_price_cents: parseOptionalPriceInput(form.maxPriceReais).cents,
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

function priceToInput(cents: number | null): string {
  return cents === null ? '' : String(cents / 100)
}

/** S21-02: the expanded row is part of the URL (`?regra=<id>`) so F5 and a
 * shared link reopen it. Read once on mount; written with `replaceState`
 * (no history entry per click), keeping the router's own `history.state`. */
function readExpandedFromUrl(): number | null {
  const raw = new URLSearchParams(window.location.search).get('regra')
  const id = raw === null ? Number.NaN : Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

function writeExpandedToUrl(id: number | null) {
  const url = new URL(window.location.href)
  if (id === null) url.searchParams.delete('regra')
  else url.searchParams.set('regra', String(id))
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

/** Newest first; the API orders by relevance (target hits first), the row
 * block wants "the latest three". */
function latestMatches(matches: Match[], count: number): Match[] {
  return [...matches]
    .sort((a, b) => (isLater(a.matched_at, b.matched_at) ? -1 : isLater(b.matched_at, a.matched_at) ? 1 : 0))
    .slice(0, count)
}

type FormTarget = { kind: 'create' } | { kind: 'edit'; rule: Rule }

/** S17-10: the "Alvo" cell — target value plus where the rule stands, judged
 * only on offers from the last 24 h (an expired offer is never "atingido"). */
function RuleTargetCell({ rule }: { rule: Rule }) {
  const targetState = ruleTargetState(rule)
  return (
    <div>
      <span className={targetState.kind === 'hit' ? 'rule-target rule-target--hit' : 'rule-target'}>
        {formatLowestPrice(rule.target_price_cents ?? null)}
      </span>
      {targetState.kind !== 'none' && (
        <span
          className="rule-target__detail"
          title={targetState.kind === 'no-offer' ? 'sem oferta nas últimas 24 h' : undefined}
        >
          {targetState.kind === 'hit'
            ? 'atingido'
            : targetState.kind === 'gap'
              ? `falta ${targetState.gapPct}%`
              : 'sem oferta 24 h'}
        </span>
      )}
    </div>
  )
}

/** S21-07: who receives a rule, from the API's resolved `recipient_ids`. */
function RuleRecipients({ rule, recipients }: { rule: Rule; recipients: Recipient[] | null }) {
  const ids = rule.recipient_ids ?? []
  if (recipients === null && ids.length > 0) return <span className="delivery-who">…</span>
  const known = (recipients ?? []).filter((recipient) => ids.includes(recipient.id))
  const label = recipientsLabel(known.map((recipient) => recipient.name))
  return (
    <span className={label.none ? 'delivery-who delivery-who--none' : 'delivery-who'}>
      {!label.none && (
        <span className="delivery-avatars">
          {known.slice(0, 3).map((recipient) => (
            <Avatar key={recipient.id} letter={initial(recipient.name)} title={recipient.name} />
          ))}
        </span>
      )}
      {label.text}
    </span>
  )
}

export function RegrasPage() {
  const { csrfToken } = useAuth()
  const fillOrigin = useFillOrigin()
  const { toast, showToast, dismiss } = useToast()
  // S13-06: the listener reads rules/sources/recipients itself; this is how the
  // panel asks it to reload, and how it learns there is something to apply.
  const listener = useListenerStatus({
    csrfToken,
    onSettled: (settled) => {
      const { message, tone } = settledToast(settled)
      showToast(message, tone)
    },
  })
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [snoozes, setSnoozes] = useState<Snooze[]>([])
  const [snoozeBusyId, setSnoozeBusyId] = useState<number | null>(null)
  const [digest, setDigest] = useState<DigestSettings | null>(null)
  const [digestError, setDigestError] = useState<string | null>(null)
  const [digestSaving, setDigestSaving] = useState(false)
  const [suggestion, setSuggestion] = useState<RuleSuggestion | null>(null)
  const [suggestionLoading, setSuggestionLoading] = useState(false)
  const [suggestionError, setSuggestionError] = useState<string | null>(null)

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
  const maxPriceInputRef = useRef<HTMLInputElement>(null)
  // S23-05: simple/advanced form mode, the picked template and the polite
  // announcement of the last change (mode switch or template applied).
  const [formMode, setFormMode] = useState<RuleFormMode>(readFormModePreference)
  const [templateId, setTemplateId] = useState<string>('blank')
  const [formAnnouncement, setFormAnnouncement] = useState('')

  // S13-07: real-history dry-run section shared by both "Testar" entry
  // points below — cleared whenever the tester panel target changes (a
  // stale preview must never look like it describes what's on screen now).
  const [formTesting, setFormTesting] = useState(false)
  const [formTestResult, setFormTestResult] = useState<RuleTestResult | null>(null)
  const [formTestError, setFormTestError] = useState<string | null>(null)
  // Only the newest request may update the shared tester panel. Changing or
  // closing the target invalidates the in-flight request synchronously, before
  // React runs the effect for the next target.
  const formTestRequestId = useRef(0)

  const [pausingId, setPausingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  // S4-06's per-row "Testar" (`testerId`) and S13-07's own "Testar" on the
  // still-unsaved "Nova regra" rail (`createTesterOpen`) are the same word
  // and the same panel (one at a time — opening either closes the other) so
  // Gabriel never sees two different "Testar" controls doing different
  // things. See `testerContext`/`effectiveTesterTerms` below for how the
  // panel picks which terms (saved rule, or live unsaved form) it tests.
  const [testerId, setTesterId] = useState<number | null>(null)
  const [createTesterOpen, setCreateTesterOpen] = useState(false)
  const [testerText, setTesterText] = useState('')

  const [checkingClearId, setCheckingClearId] = useState<number | null>(null)
  const [clearConfirm, setClearConfirm] = useState<{ rule: Rule; count: number } | null>(null)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)

  // `null` = not loaded (or failed to load) — the panel shows "—", never a
  // made-up zero.
  const [matchedCount, setMatchedCount] = useState<number | null>(null)
  const [ceilingDiscards, setCeilingDiscards] = useState<number | null>(null)

  // S21-02: one rule row open at a time (URL `?regra=<id>`), the contextual
  // right rail (rule form by default, recipient form on demand), the latest
  // matches of the open rule and a counter that makes the recipients reload.
  const [expandedId, setExpandedIdState] = useState<number | null>(readExpandedFromUrl)
  const [recipientTarget, setRecipientTarget] = useState<RecipientFormTarget | null>(null)
  const [recipientsVersion, setRecipientsVersion] = useState(0)
  const [recipients, setRecipients] = useState<Recipient[] | null>(null)
  const recipientCount = recipients === null ? null : recipients.length
  const [recent, setRecent] = useState<{ ruleId: number; matches: Match[] | null; failed: boolean } | null>(null)
  const [recentVersion, setRecentVersion] = useState(0)
  const testerPanelRef = useRef<HTMLDivElement>(null)

  const setExpandedId = (id: number | null) => {
    setExpandedIdState(id)
    writeExpandedToUrl(id)
  }

  const reload = () => {
    // S18-01: `loading` starts true and only the first load shows the
    // placeholder; a refetch after pause/resume keeps the table on screen
    // (blanking it moved the page and dropped any open row menu).
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

  const loadSnoozes = () => {
    listSnoozes().then(setSnoozes).catch(() => setListError('Não foi possível carregar os silêncios.'))
  }

  const loadDigest = () => {
    fetchDigestSettings()
      .then((settings) => {
        setDigest(settings)
        setDigestError(null)
      })
      .catch(() => setDigestError('Não foi possível carregar a entrega dos alertas.'))
  }

  useEffect(reload, [])

  // S23-04: `/regras?nova=1` (from "Comece por aqui") lands with the form focused.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get('nova') !== '1') return
    url.searchParams.delete('nova')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }, [])
  useEffect(loadStats, [])
  useEffect(loadSnoozes, [])
  useEffect(loadDigest, [])

  // A deep link to a rule that no longer exists must not leave a dead `?regra=`.
  useEffect(() => {
    if (loading || listError !== null || expandedId === null) return
    if (!rules.some((rule) => rule.id === expandedId)) {
      setExpandedIdState(null)
      writeExpandedToUrl(null)
    }
  }, [loading, listError, rules, expandedId])

  // The latest three matches of the open rule (`GET /matches?rule_id=`).
  useEffect(() => {
    if (expandedId === null) {
      setRecent(null)
      return
    }
    let cancelled = false
    setRecent({ ruleId: expandedId, matches: null, failed: false })
    fetchMatches({ ruleId: expandedId })
      .then((matches) => {
        if (!cancelled) setRecent({ ruleId: expandedId, matches: Array.isArray(matches) ? matches : [], failed: false })
      })
      .catch(() => {
        if (!cancelled) setRecent({ ruleId: expandedId, matches: null, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [expandedId, recentVersion])

  // Esc closes the open row — unless it was meant for a menu, a popover or a field.
  useEffect(() => {
    if (expandedId === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (document.querySelector('.row-actions__menu, .anchored-popover__panel')) return
      const closing = expandedId
      setExpandedIdState(null)
      writeExpandedToUrl(null)
      document.getElementById(`rule-toggle-${closing}`)?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [expandedId])
  useEffect(() => {
    const productKey = new URLSearchParams(window.location.search).get('produto')
    if (productKey === null) return
    setSuggestionLoading(true)
    fetchRuleSuggestion(productKey)
      .then((next) => {
        setSuggestion(next)
        setSuggestionError(null)
        loadForm(
          { kind: 'create' },
          {
            name: next.name,
            includeTerms: next.include_terms,
            excludeTerms: '',
            maxPriceReais: priceToInput(next.max_price_cents),
            targetPriceReais: priceToInput(next.target_price_cents),
          },
        )
        requestAnimationFrame(() => nameInputRef.current?.focus())
      })
      .catch((error: unknown) =>
        setSuggestionError(
          error instanceof ApiError ? error.message : 'Não foi possível sugerir uma regra para este produto.',
        ),
      )
      .finally(() => setSuggestionLoading(false))
    // The deep link is an initial navigation contract, not a live query editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A rule (or source/recipient) changed: reload the table and re-check what the
  // listener still has to apply, without waiting for the next poll.
  const configChanged = () => {
    reload()
    loadSnoozes()
    listener.refresh()
  }

  const handleSnooze = (rule: Rule) => {
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    const existing = snoozes.find((item) => item.scope === 'rule' && item.rule_id === rule.id)
    setSnoozeBusyId(rule.id)
    const request = existing
      ? reactivateSnooze(csrfToken, existing.id)
      : snoozeRule(csrfToken, rule.id, 7)
    request
      .then(() => {
        configChanged()
        showToast(existing ? 'Regra reativada.' : 'Regra silenciada por 7 dias.')
      })
      .catch((error: unknown) => reportFailure(error, 'Não foi possível alterar o silêncio da regra.', setListError))
      .finally(() => setSnoozeBusyId(null))
  }

  const saveDigest = () => {
    if (csrfToken === null || digest === null) {
      setDigestError(CSRF_MISSING_MESSAGE)
      return
    }
    setDigestSaving(true)
    updateDigestSettings(csrfToken, digest)
      .then((next) => {
        setDigest(next)
        setDigestError(null)
        showToast('Entrega dos alertas atualizada.')
      })
      .catch((error: unknown) =>
        setDigestError(error instanceof ApiError ? error.message : 'Não foi possível salvar a entrega.'),
      )
      .finally(() => setDigestSaving(false))
  }

  const loadForm = (target: FormTarget, next: RuleForm) => {
    const keepsCurrentTester =
      target.kind === 'edit' && testerId !== null && testerId === target.rule.id
    if (!keepsCurrentTester) {
      formTestRequestId.current += 1
      setFormTesting(false)
    }
    setFormTarget(target)
    setForm(next)
    setTemplateId('blank')
    setFormAnnouncement('')
    // A rule already using blocked terms or `a + b` opens straight in the
    // advanced mode; anything else follows the remembered preference.
    setFormMode(usesAdvancedFields(next) ? 'advanced' : readFormModePreference())
    setFormVersion((version) => version + 1)
    setFormError(null)
    // The still-unsaved "Nova regra" tester never survives a form reload —
    // whatever was being tested there is gone the moment the rail loads
    // different data. A row's own tester survives only if it's the exact
    // rule now loaded for editing (the live-preview flow); any other case
    // closes it too, so it never keeps showing a rule that isn't on screen.
    setCreateTesterOpen(false)
    setTesterId((current) => (target.kind === 'edit' && current === target.rule.id ? current : null))
  }

  // The rail may be showing the recipient form: bring the rule form back first,
  // then focus its name field once it is on screen.
  const focusRuleName = () => {
    if (recipientTarget === null) {
      nameInputRef.current?.focus()
      return
    }
    setRecipientTarget(null)
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }

  const openCreate = () => {
    setSuggestion(null)
    setSuggestionError(null)
    loadForm({ kind: 'create' }, EMPTY_FORM)
    focusRuleName()
  }

  const openEdit = (rule: Rule) => {
    loadForm({ kind: 'edit', rule }, ruleToForm(rule, { asCopy: false }))
    focusRuleName()
  }

  const openDuplicate = (rule: Rule) => {
    loadForm({ kind: 'create' }, ruleToForm(rule, { asCopy: true }))
    focusRuleName()
  }

  const changeFormMode = (mode: RuleFormMode) => {
    setFormMode(mode)
    writeFormModePreference(mode)
    setFormAnnouncement(mode === 'advanced' ? 'Modo avançado: mais opções disponíveis.' : 'Modo simples.')
  }

  const applyTemplate = (id: string) => {
    setTemplateId(id)
    const template = RULE_TEMPLATES.find((candidate) => candidate.id === id)
    setForm(
      template
        ? { name: template.name, includeTerms: template.includeTerms, excludeTerms: template.excludeTerms, maxPriceReais: '', targetPriceReais: '' }
        : EMPTY_FORM,
    )
    setFormVersion((version) => version + 1)
    setFormError(null)
    if (template) {
      setFormAnnouncement(`Modelo ${template.label} aplicado. Agora diga até quanto você paga.`)
      requestAnimationFrame(() => maxPriceInputRef.current?.focus())
    } else {
      setFormAnnouncement('Formulário em branco.')
      requestAnimationFrame(() => nameInputRef.current?.focus())
    }
  }

  const openRecipientCreate = () => setRecipientTarget({ kind: 'create' })
  const openRecipientEdit = (recipient: Recipient) => setRecipientTarget({ kind: 'edit', recipient })
  const closeRecipientForm = () => setRecipientTarget(null)
  const recipientSaved = () => {
    setRecipientTarget(null)
    setRecipientsVersion((version) => version + 1)
    listener.refresh()
    reload()
  }
  // A card saved new delivery settings: the "Destinatários" column of the rules
  // table (computed by the API) must follow.
  const recipientsChanged = () => {
    listener.refresh()
    reload()
  }

  const resetForm = () => {
    setSuggestion(null)
    loadForm({ kind: 'create' }, EMPTY_FORM)
  }

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
    const termsProblem = termsError(form.includeTerms) ?? termsError(form.excludeTerms)
    if (termsProblem !== null) {
      setFormError(termsProblem)
      return
    }
    // S14-13: validate both price fields with the one parser before ever
    // building the request — a malformed "Teto"/"Alvo" now shows its own
    // pt-BR error instead of silently saving `null`/`NaN`.
    const maxPrice = parseOptionalPriceInput(form.maxPriceReais)
    if (maxPrice.error !== null) {
      setFormError(maxPrice.error)
      return
    }
    const targetPrice = parseOptionalPriceInput(form.targetPriceReais)
    if (targetPrice.error !== null) {
      setFormError(targetPrice.error)
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
        configChanged()
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
        configChanged()
        showToast('Regra pausada.')
      })
      .catch((error: unknown) => reportFailure(error, 'Não foi possível pausar a regra.', setListError))
      .finally(() => setPausingId(null))
  }

  const handleResume = (rule: Rule) => {
    if (csrfToken === null) {
      setListError(CSRF_MISSING_MESSAGE)
      return
    }
    setPausingId(rule.id)
    resumeRule(csrfToken, rule.id)
      .then(() => {
        configChanged()
        showToast('Regra reativada.')
      })
      .catch((error: unknown) => reportFailure(error, 'Não foi possível reativar a regra.', setListError))
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
        configChanged()
        showToast('Regra excluída.')
      })
      .catch((error: unknown) => {
        reportFailure(error, error instanceof ApiError ? error.message : 'Não foi possível excluir a regra.', setListError)
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
        setRecentVersion((version) => version + 1)
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

  const isEditing = formTarget.kind === 'edit'

  // S13-07: which "Testar" panel (if any) is open, and which terms it tests.
  // A row's own saved rule — unless that exact rule is the one currently
  // loaded live in the edit rail, in which case its not-yet-saved form
  // values are what Gabriel actually wants previewed — or the still-unsaved
  // "Nova regra" rail form itself. Recomputed every render (not memoized) so
  // typing in the rail live-updates the local ✅/❌ verdict below without a
  // network call; only the real-history fetch is explicitly triggered.
  type TesterContext = { kind: 'rule'; rule: Rule } | { kind: 'create' } | null
  const testerContext: TesterContext =
    testerId !== null
      ? (() => {
          const rule = rules.find((candidate) => candidate.id === testerId)
          return rule ? { kind: 'rule' as const, rule } : null
        })()
      : createTesterOpen
        ? { kind: 'create' as const }
        : null

  const liveFormTerms = (): RuleTestInput => formToTestInput(form)

  const effectiveTesterTerms = (
    context: TesterContext,
  ): { include: string; exclude: string | null; maxPriceCents: number | null } | null => {
    if (context === null) return null
    if (context.kind === 'create') {
      const live = liveFormTerms()
      return { include: live.include_terms, exclude: live.exclude_terms ?? null, maxPriceCents: live.max_price_cents ?? null }
    }
    if (formTarget.kind === 'edit' && formTarget.rule.id === context.rule.id) {
      const live = liveFormTerms()
      return { include: live.include_terms, exclude: live.exclude_terms ?? null, maxPriceCents: live.max_price_cents ?? null }
    }
    return {
      include: context.rule.include_terms,
      exclude: context.rule.exclude_terms,
      maxPriceCents: context.rule.max_price_cents,
    }
  }

  const preview = useRulePreview(csrfToken, formToTestInput(form), recipientTarget === null)
  const previewText = previewMessage(preview)

  const currentTesterTerms = effectiveTesterTerms(testerContext)

  // S13-07: the real-history half of the panel — explicitly triggered
  // (opening the panel, or "Atualizar"), never on every keystroke, so
  // editing the form doesn't spam `POST /rules/test`. Reads only: creates
  // no `Match`/`Delivery`, advances no cursor, calls no `BotNotifier`.
  const fetchRealTesterPreview = (
    terms: { include: string; exclude: string | null; maxPriceCents: number | null } | null,
  ) => {
    const requestId = ++formTestRequestId.current
    if (terms === null) return
    if (csrfToken === null) {
      setFormTesting(false)
      setFormTestError(CSRF_MISSING_MESSAGE)
      setFormTestResult(null)
      return
    }
    if (parseTermList(terms.include).length === 0) {
      setFormTesting(false)
      setFormTestError(NO_TERMS_MESSAGE)
      setFormTestResult(null)
      return
    }
    setFormTesting(true)
    setFormTestError(null)
    setFormTestResult(null)
    testRule(csrfToken, {
      include_terms: terms.include,
      exclude_terms: terms.exclude,
      max_price_cents: terms.maxPriceCents,
    })
      .then((result) => {
        if (formTestRequestId.current === requestId) setFormTestResult(result)
      })
      .catch((error: unknown) => {
        if (formTestRequestId.current !== requestId) return
        setFormTestResult(null)
        setFormTestError(error instanceof ApiError ? error.message : 'Não foi possível testar a regra.')
      })
      .finally(() => {
        if (formTestRequestId.current === requestId) setFormTesting(false)
      })
  }

  // Opens with the terms captured at click time and loads the real-history
  // half right away; the local ✅/❌ field then stays live on its own.
  useEffect(() => {
    if (testerContext === null) {
      setFormTestResult(null)
      setFormTestError(null)
      return
    }
    fetchRealTesterPreview(effectiveTesterTerms(testerContext))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testerId, createTesterOpen])

  const closeTester = () => {
    formTestRequestId.current += 1
    setFormTesting(false)
    setTesterId(null)
    setCreateTesterOpen(false)
    setTesterText('')
  }

  const toggleRowTester = (rule: Rule) => {
    if (testerId === rule.id) {
      closeTester()
      return
    }
    formTestRequestId.current += 1
    setFormTesting(false)
    setTesterId(rule.id)
    setCreateTesterOpen(false)
    setTesterText('')
    // The panel sits below the table: a row far from it must still show it.
    requestAnimationFrame(() => testerPanelRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }))
  }

  const toggleCreateTester = () => {
    if (createTesterOpen) {
      closeTester()
      return
    }
    formTestRequestId.current += 1
    setFormTesting(false)
    setCreateTesterOpen(true)
    setTesterId(null)
    setTesterText('')
  }

  const matchHelp = (
    <AnchoredPopover
      triggerLabel="Como uma regra casa"
      triggerContent="?"
      triggerClassName="regras-help-button"
      title="Como uma regra casa"
    >
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
    </AnchoredPopover>
  )

  const subtitleParts = [rules.length === 1 ? '1 regra' : `${rules.length} regras`]
  if (recipientCount !== null) {
    subtitleParts.push(recipientCount === 1 ? '1 destinatário' : `${recipientCount} destinatários`)
  }

  return (
    <main className="crud-page regras-page">
      <div className="regras-page__header">
        <div>
          <h1>Regras</h1>
          {!loading && !listError && <p className="regras-page__subtitle">{subtitleParts.join(' · ')}</p>}
        </div>
        <div className="regras-page__header-actions">
          <ListenerApplyControl
            status={listener.status}
            error={listener.error}
            requesting={listener.requesting}
            onApply={listener.apply}
          />
          <button
            type="button"
            className="plane-action fill-button regras-page__new-button"
            onClick={openCreate}
            onPointerDown={fillOrigin}
          >
            + Nova regra
          </button>
        </div>
      </div>

      <FirstTimeTip id="regras">
        Uma regra define o que procurar e até quanto pagar. O teleyes lê os grupos e só avisa quando uma promoção bate.
      </FirstTimeTip>

      <div className="regras-page__grid">
        <div className="regras-page__main">
          {loading && <p role="status" className="regras-page__loading">Carregando regras…</p>}
          {listError && (
            <p role="alert" className="crud-page__error">
              {listError}
            </p>
          )}

          {!loading && !listError && (
            <div className="plane-pearl rules-table-wrap">
              <table className="rules-table">
                <thead>
                  <tr>
                    <th>Regra</th>
                    <th className="rules-table__num">Teto</th>
                    <th className="rules-table__num">Alvo</th>
                    <th className="rules-table__recipients">Destinatários</th>
                    <th className="rules-table__status">Status</th>
                    <th className="rules-table__actions">
                      <span className="rules-table__sr">Ações</span>
                    </th>
                  </tr>
                </thead>
                {rules.map((rule) => {
                  const expanded = expandedId === rule.id
                  const detailId = `rule-detail-${rule.id}`
                  const editing = formTarget.kind === 'edit' && formTarget.rule.id === rule.id
                  return (
                    <tbody
                      key={rule.id}
                      className={['rules-table__group', expanded ? 'rules-table__group--open' : '', editing ? 'rules-table__group--editing' : '', rule.active ? '' : 'rules-table__group--paused']
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <tr className="rules-table__row">
                        <td className="rules-table__name" data-label="Regra">
                          <button
                            type="button"
                            id={`rule-toggle-${rule.id}`}
                            className="rule-row__toggle"
                            aria-expanded={expanded}
                            aria-controls={expanded ? detailId : undefined}
                            onClick={() => setExpandedId(expanded ? null : rule.id)}
                          >
                            <svg className="rule-row__chevron" viewBox="0 0 12 12" aria-hidden="true">
                              <path d="M4 2.5 8 6l-4 3.5" />
                            </svg>
                            <span className="rule-row__text">
                              <span className="rule-row__title">{rule.name}</span>
                              <span className="wide-table__terms">{rule.include_terms}</span>
                            </span>
                          </button>
                        </td>
                        <td className="rules-table__num" data-label="Teto">
                          {formatPriceLimit(rule.max_price_cents)}
                        </td>
                        <td className="rules-table__num" data-label="Alvo">
                          {/* S15-02: one box, so the stacked phone card keeps value and
                              gap together on the right instead of spreading them. */}
                          <RuleTargetCell rule={rule} />
                        </td>
                        <td className="rules-table__recipients" data-label="Destinatários">
                          <RuleRecipients rule={rule} recipients={recipients} />
                        </td>
                        <td className="rules-table__status" data-label="Status">
                          <div className="rule-status">
                            <StatusToggle
                              active={rule.active}
                              pausing={pausingId === rule.id}
                              onPause={() => handlePause(rule)}
                              onResume={() => handleResume(rule)}
                            />
                            {rule.snoozed_until && (
                              <span className="rule-silence rule-silence--muted">
                                <span aria-hidden="true" />
                                silenciada até {formatDayMonth(rule.snoozed_until)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="rules-table__actions">
                          <RowActionsMenu
                            label={`Mais ações da regra ${rule.name}`}
                            items={[
                              { key: 'edit', label: 'Editar', onSelect: () => openEdit(rule) },
                              { key: 'test', label: 'Testar', onSelect: () => toggleRowTester(rule) },
                              { key: 'duplicate', label: 'Duplicar', onSelect: () => openDuplicate(rule) },
                              {
                                key: 'snooze',
                                label:
                                  snoozeBusyId === rule.id
                                    ? 'Salvando…'
                                    : rule.snoozed_until
                                      ? 'Reativar'
                                      : 'Silenciar',
                                onSelect: () => handleSnooze(rule),
                                disabled: snoozeBusyId === rule.id,
                              },
                              {
                                key: 'clear',
                                label: checkingClearId === rule.id ? 'Checando…' : 'Limpar histórico',
                                onSelect: () => openClearConfirm(rule),
                                disabled: checkingClearId === rule.id,
                                danger: true,
                                separatorBefore: true,
                              },
                              {
                                key: 'delete',
                                label: 'Excluir',
                                onSelect: () => handleDelete(rule),
                                disabled: deletingId === rule.id,
                                danger: true,
                              },
                            ]}
                          />
                        </td>
                      </tr>
                      {expanded && (
                        <tr id={detailId} className="rules-table__detail">
                          <td colSpan={6}>
                            <div className="rule-detail" role="region" aria-label={`Detalhes da regra ${rule.name}`}>
                              <RuleHistoryChart
                                points={rule.history_30d ?? []}
                                ceilingCents={rule.max_price_cents}
                                targetCents={rule.target_price_cents}
                              />
                              <div className="rule-detail__side">
                                {recipients !== null && recipientsMissingRule(recipients, rule).length > 0 && (
                                  <p className="delivery-warn" role="status">
                                    {recipientsMissingRule(recipients, rule).length === 1
                                      ? '1 destinatário não recebe esta regra'
                                      : `${recipientsMissingRule(recipients, rule).length} destinatários não recebem esta regra`}
                                  </p>
                                )}
                                <h3 className="rule-detail__heading">Últimos matches</h3>
                                {(recent === null || recent.ruleId !== rule.id || (recent.matches === null && !recent.failed)) && (
                                  <p role="status" className="rule-detail__muted">Carregando matches…</p>
                                )}
                                {recent?.ruleId === rule.id && recent.failed && (
                                  <p role="alert" className="rule-detail__muted">Não foi possível carregar os matches.</p>
                                )}
                                {recent?.ruleId === rule.id && recent.matches !== null && recent.matches.length === 0 && (
                                  <p className="rule-detail__muted">Nenhum match ainda para esta regra.</p>
                                )}
                                {recent?.ruleId === rule.id && recent.matches !== null && recent.matches.length > 0 && (
                                  <ul className="rule-detail__matches">
                                    {latestMatches(recent.matches, 3).map((match) => (
                                      <li key={match.id}>
                                        <span className="rule-detail__match-price">{formatLowestPrice(match.price_cents)}</span>
                                        <span className="rule-detail__match-text">{match.message_text}</span>
                                        <span className="rule-detail__match-meta">
                                          {formatMatchedAt(match.matched_at)}
                                          {match.message_link !== null && (
                                            <>
                                              {' · '}
                                              <a href={match.message_link} target="_blank" rel="noopener noreferrer">
                                                Abrir mensagem
                                              </a>
                                            </>
                                          )}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                                <div className="rule-detail__actions">
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
                                    onClick={() => toggleRowTester(rule)}
                                  >
                                    Testar
                                  </button>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  )
                })}
                {rules.length === 0 && (
                  <tbody>
                    <tr>
                      <td colSpan={5} className="regras-page__empty">
                        <EmptyState
                          title="Nenhuma regra ainda"
                          text="Uma regra diz o que procurar e até quanto pagar. O teleyes só avisa quando uma promoção bate nela."
                          action={{ label: 'Criar a primeira regra', onClick: openCreate }}
                        />
                      </td>
                    </tr>
                  </tbody>
                )}
              </table>
            </div>
          )}

          {testerContext !== null && currentTesterTerms !== null && (
            <div ref={testerPanelRef} className="plane-pearl regras-panel">
              <div className="regras-panel__heading">
                <h2>
                  {testerContext.kind === 'create'
                    ? 'Testar regra: nova regra (ainda não salva)'
                    : `Testar regra: ${testerContext.rule.name}`}
                </h2>
                <button type="button" className="plane-action plane-action--secondary plane-action--compact" onClick={closeTester}>
                  Fechar
                </button>
              </div>
              <p className="regras-panel__note">
                {testerContext.kind === 'rule' &&
                formTarget.kind === 'edit' &&
                formTarget.rule.id === testerContext.rule.id
                  ? 'Testando os campos ainda não salvos do formulário ao lado.'
                  : 'Prévia local (não chama a API nem cria dado nenhum) — reproduz a mesma lógica de normalização e termos do backend.'}
              </p>
              <label className="regras-panel__field">
                Mensagem de exemplo
                <input value={testerText} onChange={(event) => setTesterText(event.target.value)} />
              </label>
              {testerText.trim() !== '' && (
                <p className="regras-panel__verdict">
                  {previewRuleMatch(testerText, currentTesterTerms.include, currentTesterTerms.exclude)
                    ? '✅ Bateria com esta regra'
                    : '❌ Não bateria com esta regra'}
                </p>
              )}

              {/* S13-07: retained matches from the last `window_days` that
                  these (possibly still unsaved) terms would have caught. Raw
                  discarded Telegram messages are deliberately not retained. */}
              <div className="regras-test-section">
                <div className="regras-test-section__header">
                  <h3>Promoções já salvas que bateriam</h3>
                  <button
                    type="button"
                    className="plane-action plane-action--secondary plane-action--compact"
                    onClick={() => fetchRealTesterPreview(currentTesterTerms)}
                    disabled={formTesting}
                  >
                    {formTesting ? 'Buscando…' : 'Atualizar'}
                  </button>
                </div>
                <p className="regras-panel__note">
                  A prévia consulta somente promoções já capturadas e salvas como match.
                  Mensagens descartadas não ficam armazenadas, então isto não é uma varredura
                  completa do Telegram.
                </p>
                {formTesting && (
                  <p role="status" className="regras-test-section__status">
                    Buscando mensagens…
                  </p>
                )}
                {formTestError && (
                  <p role="alert" className="regras-panel__error">
                    {formTestError}
                  </p>
                )}
                {!formTesting && formTestResult && formTestResult.messages.length === 0 && (
                  <p className="regras-test-section__empty">
                    Nenhuma promoção já capturada e salva bateu com esses termos nos últimos{' '}
                    {formTestResult.window_days} dias.
                  </p>
                )}
                {!formTesting && formTestResult && formTestResult.messages.length > 0 && (
                  <>
                    <p className="regras-test-section__count">
                      {formTestResult.total_matched === 1
                        ? '1 promoção já salva bateria com esses termos'
                        : `${formTestResult.total_matched} promoções já salvas bateriam com esses termos`}{' '}
                      nos últimos {formTestResult.window_days} dias.
                    </p>
                    <ul className="regras-test-section__list">
                      {formTestResult.messages.map((message, index) => (
                        <li key={index} className="regras-test-section__item">
                          <p className="regras-test-section__text">{message.message_text}</p>
                          <p className="regras-test-section__meta">
                            {message.source_name} · {formatMatchedAt(message.matched_at)} ·{' '}
                            {formatLowestPrice(message.price_cents)}
                          </p>
                          <p className="regras-test-section__term">Termo: "{message.matched_term}"</p>
                          {message.message_link !== null && (
                            <a
                              href={message.message_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="regras-test-section__link"
                            >
                              Abrir mensagem original
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                    {formTestResult.total_matched > formTestResult.messages.length && (
                      <p className="regras-test-section__more">
                        Mostrando as {formTestResult.messages.length} mais recentes de{' '}
                        {formTestResult.total_matched}.
                      </p>
                    )}
                  </>
                )}
              </div>
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

          <DestinatariosSection
            onChanged={recipientsChanged}
            rules={rules}
            digest={digest}
            version={recipientsVersion}
            editingId={recipientTarget?.kind === 'edit' ? recipientTarget.recipient.id : null}
            onAdd={openRecipientCreate}
            onEdit={openRecipientEdit}
            onLoaded={setRecipients}
            headerExtra={
              <DeliveryAdjustments
                digest={digest}
                error={digestError}
                saving={digestSaving}
                onChange={setDigest}
                onSave={saveDigest}
              />
            }
          />
        </div>

        <aside className="regras-page__rail">
          {recipientTarget !== null ? (
            <RecipientRailForm
              key={recipientTarget.kind === 'edit' ? `edit-${recipientTarget.recipient.id}` : 'create'}
              target={recipientTarget}
              rules={rules}
              onSaved={recipientSaved}
              onCancel={closeRecipientForm}
            />
          ) : (
            <form className="plane-glass regras-form" onSubmit={submitForm}>
            <div className="regras-form__title-row">
              <h2 className="regras-rail__eyebrow">{isEditing ? 'Editar regra' : 'Nova regra'}</h2>
              {suggestion && !isEditing && <span className="regras-form__badge">pré-preenchida do produto</span>}
            </div>
            {suggestionLoading && <p role="status" className="regras-form__helper">Buscando sugestão do histórico…</p>}
            {suggestionError && <p role="alert" className="regras-form__error">{suggestionError}</p>}
            {!isEditing && (
              <div role="group" aria-labelledby="rule-templates-label" className="regras-templates">
                <p id="rule-templates-label" className="regras-templates__label">Começar de um modelo</p>
                <div className="regras-templates__list">
                  {[{ id: 'blank', label: 'Em branco' }, ...RULE_TEMPLATES].map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="regras-templates__chip"
                      aria-pressed={templateId === template.id}
                      onClick={() => applyTemplate(template.id)}
                    >
                      {template.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
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
              label="O que você procura"
              labelAction={matchHelp}
              value={form.includeTerms}
              onChange={(includeTerms) => setForm((current) => ({ ...current, includeTerms }))}
              helper={
                formMode === 'advanced'
                  ? 'Enter ou vírgula pra adicionar. Use + para exigir várias palavras, ex.: memoria ram + 16gb.'
                  : 'Enter ou vírgula pra adicionar cada palavra ou produto.'
              }
            />
            {formMode === 'advanced' && (
              <>
                <label className="regras-form__field">
                  Termos bloqueados
                  <input
                    value={form.excludeTerms}
                    onChange={(event) => setForm({ ...form, excludeTerms: event.target.value })}
                    placeholder="usado, caixa aberta…"
                    aria-describedby="rule-exclude-terms-hint"
                  />
                </label>
                <p id="rule-exclude-terms-hint" className="regras-form__helper">
                  Vírgula separa termos; + exige várias palavras, ex.: ssd + 512.
                </p>
                <p className="regras-form__helper regras-form__plus-help">
                  <strong>a + b</strong> só casa quando a mensagem tem as duas palavras (em qualquer ordem). Termos
                  separados por vírgula funcionam como alternativas: basta um aparecer.
                </p>
              </>
            )}
            {formMode === 'simple' && parseTermList(form.excludeTerms).length > 0 && (
              <p className="regras-form__helper">
                Já bloqueamos termos comuns ({parseTermList(form.excludeTerms).slice(0, 3).join(', ')}…). Veja e
                edite em Mais opções.
              </p>
            )}
            <div className="regras-form__price-grid">
              <label className="regras-form__field">
                Até quanto você paga (R$)
                <input
                  ref={maxPriceInputRef}
                  type="text"
                  inputMode="decimal"
                  value={form.maxPriceReais}
                  onChange={(event) => setForm({ ...form, maxPriceReais: event.target.value })}
                  placeholder="sem teto"
                />
              </label>
              <label className="regras-form__field">
                Avisar na hora se cair abaixo de (R$)
                <input
                  type="text"
                  inputMode="decimal"
                  value={form.targetPriceReais}
                  onChange={(event) => setForm({ ...form, targetPriceReais: event.target.value })}
                  placeholder="sem alvo"
                />
              </label>
            </div>
            {suggestion && (
              <p className="regras-form__suggestion-note">
                <span aria-hidden="true" />
                Sugerido a partir do histórico: teto = média 30d ({formatLowestPrice(suggestion.average_30d_cents)}) −3%; alvo = menor 90d ({formatLowestPrice(suggestion.lowest_90d_cents)}).
              </p>
            )}
            <p aria-live="polite" className="regras-form__preview" data-testid="rule-preview">
              {previewText}
            </p>
            <p aria-live="polite" className="regras-form__sr">{formAnnouncement}</p>
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
            {/* S13-07: the row's own "Testar" (S4-06) already covers the
                edit case — editing a rule keeps that same row's panel valid,
                it just starts reading the live unsaved fields instead of the
                saved ones (see `effectiveTesterTerms`). A brand new rule has
                no row yet, so creation gets its own entry to the same
                panel/state, never a second differently-labeled button. */}
            {!isEditing && (
              <button
                type="button"
                className="plane-action plane-action--secondary regras-form__test-button"
                onClick={toggleCreateTester}
              >
                {createTesterOpen ? 'Fechar teste' : 'Testar'}
              </button>
            )}
            <button
              type="button"
              className="regras-form__mode-link"
              aria-expanded={formMode === 'advanced'}
              onClick={() => changeFormMode(formMode === 'advanced' ? 'simple' : 'advanced')}
            >
              {formMode === 'advanced' ? 'Menos opções' : 'Mais opções'}
            </button>
            {formError && (
              <p role="alert" className="regras-form__error">
                {formError}
              </p>
            )}
            </form>
          )}
        </aside>
      </div>
      <Toast toast={toast} onDismiss={dismiss} />
    </main>
  )
}
