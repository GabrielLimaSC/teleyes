import { useState } from 'react'
import type { FormEvent } from 'react'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import { createRecipient, updateRecipient } from '../api/recipients'
import type { RecipientInput } from '../api/recipients'
import { testNotification } from '../api/notifications'
import { ApiError } from '../api/auth'
import type { Recipient, Rule, RulesMode } from '../api/types'
import { useRecipientPreview } from '../hooks/useRecipientPreview'
import { useFillOrigin } from '../utils/useFillOrigin'
import { DeliverySwitch, ModeSegmented } from './RecipientDeliveryParts'
import { ruleCountLabel } from './recipientDelivery'
import '../components/FillButton.css'
import './RegrasPage.css'
import './RecipientDelivery.css'

export type RecipientFormTarget = { kind: 'create' } | { kind: 'edit'; recipient: Recipient }

interface RecipientForm {
  name: string
  telegramChatId: string
  allowlisted: boolean
  rulesMode: RulesMode
  ruleIds: number[]
  notifyTarget: boolean
  notifyCommon: boolean
}

function initialForm(target: RecipientFormTarget): RecipientForm {
  if (target.kind === 'create') {
    return {
      name: '',
      telegramChatId: '',
      allowlisted: true,
      rulesMode: 'all',
      ruleIds: [],
      notifyTarget: true,
      notifyCommon: true,
    }
  }
  return {
    name: target.recipient.name,
    telegramChatId: target.recipient.telegram_chat_id,
    allowlisted: target.recipient.allowlisted,
    rulesMode: target.recipient.rules_mode,
    ruleIds: target.recipient.rule_ids,
    notifyTarget: target.recipient.notify_target,
    notifyCommon: target.recipient.notify_common,
  }
}

function typesPhrase(target: boolean, common: boolean): string {
  if (target && common) return 'em alvos atingidos e matches comuns'
  if (target) return 'só quando o alvo for atingido'
  if (common) return 'só em matches comuns'
  return 'sem nenhum tipo de alerta'
}

/**
 * S21-02: the recipient form, moved to the Regras page's contextual right rail.
 * It only replaces the rule form while a recipient is being created or edited
 * ("+ Adicionar destinatário" / "Editar"); "Cancelar" hands the rail back.
 * S21-07: creating also picks which rules and alert types the person receives
 * (with a live preview); editing an existing recipient keeps the identity
 * fields here and the delivery behaviour on its card. Remount it (`key`) per
 * target so a half-typed value never leaks across.
 */
export function RecipientRailForm({
  target,
  rules,
  onSaved,
  onCancel,
}: {
  target: RecipientFormTarget
  rules: Rule[]
  onSaved: () => void
  onCancel: () => void
}) {
  const { csrfToken } = useAuth()
  const fillOrigin = useFillOrigin()
  const creating = target.kind === 'create'
  const [form, setForm] = useState<RecipientForm>(() => initialForm(target))
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const choosing = form.rulesMode === 'selected'
  const noRule = creating && choosing && form.ruleIds.length === 0
  const noType = creating && choosing && !form.notifyTarget && !form.notifyCommon
  const invalid = noRule || noType
  const { preview } = useRecipientPreview(
    {
      rules_mode: form.rulesMode,
      rule_ids: form.ruleIds,
      notify_target: form.notifyTarget,
      notify_common: form.notifyCommon,
    },
    creating && !invalid,
  )

  const toggleRule = (ruleId: number) =>
    setForm((current) => ({
      ...current,
      ruleIds: current.ruleIds.includes(ruleId)
        ? current.ruleIds.filter((id) => id !== ruleId)
        : [...current.ruleIds, ruleId],
    }))

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (invalid) return
    if (csrfToken === null) {
      setFormError(CSRF_MISSING_MESSAGE)
      return
    }
    setSubmitting(true)
    setFormError(null)
    const identity: RecipientInput = {
      name: form.name,
      telegram_chat_id: form.telegramChatId,
      allowlisted: form.allowlisted,
    }
    const request = creating
      ? createRecipient(csrfToken, {
          ...identity,
          rules_mode: form.rulesMode,
          rule_ids: choosing ? form.ruleIds : [],
          notify_target: form.notifyTarget,
          notify_common: form.notifyCommon,
        })
      : updateRecipient(csrfToken, target.recipient.id, identity)
    request
      .then(onSaved)
      .catch((error: unknown) => {
        setFormError(error instanceof ApiError ? error.message : 'Não foi possível salvar o destinatário.')
      })
      .finally(() => setSubmitting(false))
  }

  const sendTest = () => {
    if (csrfToken === null || target.kind !== 'edit') return
    setTesting(true)
    setTestResult(null)
    testNotification(csrfToken, target.recipient.telegram_chat_id, 'Teste de notificação do teleyes.')
      .then((result) =>
        setTestResult(
          result.delivered
            ? { tone: 'ok', text: 'Mensagem de teste entregue.' }
            : { tone: 'error', text: `Não entregue (${result.status}).` },
        ),
      )
      .catch((error: unknown) =>
        setTestResult({
          tone: 'error',
          text: error instanceof ApiError ? error.message : 'Não foi possível enviar o teste.',
        }),
      )
      .finally(() => setTesting(false))
  }

  const perRule = new Map((preview?.per_rule ?? []).map((item) => [item.rule_id, item.per_week]))
  const personName = form.name.trim() === '' ? 'Esta pessoa' : form.name.trim()
  const ruleCount = choosing ? form.ruleIds.length : rules.length
  const previewPhrase =
    preview === null
      ? null
      : `${personName} vai receber ${choosing ? ruleCountLabel(ruleCount) : `todas as ${ruleCountLabel(ruleCount)}`}, ${typesPhrase(form.notifyTarget, form.notifyCommon)} — ${
          preview.alerts_per_week === 0
            ? 'nenhum alerta na última semana no ritmo atual.'
            : `cerca de ${preview.alerts_per_week} ${preview.alerts_per_week === 1 ? 'alerta' : 'alertas'} por semana no ritmo atual.`
        }`

  return (
    <form className="plane-glass regras-form" onSubmit={submit}>
      <h2 className="regras-rail__eyebrow">{creating ? 'Novo destinatário' : 'Editar destinatário'}</h2>
      <label className="regras-form__field">
        Nome
        <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
      </label>
      <label className="regras-form__field">
        Chat ID do Telegram
        <input
          value={form.telegramChatId}
          onChange={(event) => setForm({ ...form, telegramChatId: event.target.value })}
          required
        />
      </label>
      <p className="regras-form__helper">A pessoa precisa ter iniciado conversa com o bot.</p>
      <label className="regras-form__check">
        <input
          type="checkbox"
          checked={form.allowlisted}
          onChange={(event) => setForm({ ...form, allowlisted: event.target.checked })}
        />{' '}
        Autorizado a receber alertas
      </label>

      {creating && (
        <>
          <fieldset className="delivery-fieldset">
            <legend>Receber alertas de</legend>
            <ModeSegmented
              value={form.rulesMode}
              label="Receber alertas de"
              onChange={(rulesMode) => setForm({ ...form, rulesMode })}
            />
            {choosing && rules.length === 0 && <p className="delivery-muted">Nenhuma regra criada ainda.</p>}
            {choosing && rules.length > 0 && (
              <ul className="delivery-picker">
                {rules.map((rule) => {
                  const checked = form.ruleIds.includes(rule.id)
                  return (
                    <li key={rule.id} className="delivery-picker__item">
                      <label>
                        <input type="checkbox" checked={checked} onChange={() => toggleRule(rule.id)} />
                        <span>{rule.name}</span>
                      </label>
                      <span className="delivery-picker__count">
                        {checked && perRule.has(rule.id) ? `${perRule.get(rule.id)}/sem` : '—'}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </fieldset>

          <fieldset className="delivery-fieldset">
            <legend>Tipos de alerta</legend>
            <div className="recipient-card__line">
              <span>Alvo atingido</span>
              <DeliverySwitch
                checked={form.notifyTarget}
                label="Alvo atingido"
                onChange={(notifyTarget) => setForm({ ...form, notifyTarget })}
              />
            </div>
            <div className="recipient-card__line">
              <span>Match comum</span>
              <DeliverySwitch
                checked={form.notifyCommon}
                label="Match comum"
                onChange={(notifyCommon) => setForm({ ...form, notifyCommon })}
              />
            </div>
          </fieldset>

          {noRule && <p className="delivery-warn">Escolha ao menos uma regra para continuar.</p>}
          {noType && <p className="delivery-warn">Ligue ao menos um tipo de alerta para continuar.</p>}
          {previewPhrase && (
            <p className="delivery-preview" role="status">
              {previewPhrase}
            </p>
          )}
        </>
      )}

      <div className="regras-form__actions">
        <button
          type="submit"
          className="plane-action fill-button regras-form__submit"
          disabled={submitting || invalid}
          onPointerDown={fillOrigin}
        >
          {submitting ? 'Salvando…' : creating ? 'Adicionar' : 'Salvar'}
        </button>
        <button
          type="button"
          className="plane-action plane-action--secondary regras-form__cancel"
          onClick={sendTest}
          disabled={creating || testing}
          title={creating ? 'Disponível depois de adicionar o destinatário.' : undefined}
        >
          {testing ? 'Enviando…' : 'Enviar teste'}
        </button>
        <button type="button" className="plane-action plane-action--secondary regras-form__cancel" onClick={onCancel}>
          Cancelar
        </button>
      </div>
      {testResult && (
        <p role={testResult.tone === 'error' ? 'alert' : 'status'} className={testResult.tone === 'error' ? 'regras-form__error' : 'regras-form__helper'}>
          {testResult.text}
        </p>
      )}
      {formError && (
        <p role="alert" className="regras-form__error">
          {formError}
        </p>
      )}
    </form>
  )
}
