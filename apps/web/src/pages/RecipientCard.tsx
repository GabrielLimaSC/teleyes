import { useState } from 'react'
import { CSRF_MISSING_MESSAGE, useAuth } from '../auth/AuthContext'
import { ApiError } from '../api/auth'
import { testNotification } from '../api/notifications'
import { updateRecipient } from '../api/recipients'
import type { DigestSettings, Recipient, Rule, RulesMode } from '../api/types'
import { useRecipientPreview } from '../hooks/useRecipientPreview'
import { StatusToggle } from '../components/StatusToggle'
import { Avatar, DeliverySwitch, ModeSegmented, RuleChips } from './RecipientDeliveryParts'
import { commonLine, initial, ruleCountLabel, targetLine, typesLabel, weeklyLabel } from './recipientDelivery'
import './RecipientDelivery.css'

interface Draft {
  mode: RulesMode
  ruleIds: number[]
  notifyTarget: boolean
  notifyCommon: boolean
}

function draftOf(recipient: Recipient): Draft {
  return {
    mode: recipient.rules_mode,
    ruleIds: recipient.rule_ids,
    notifyTarget: recipient.notify_target,
    notifyCommon: recipient.notify_common,
  }
}

function signature(recipient: Recipient): string {
  return JSON.stringify([recipient.rules_mode, [...recipient.rule_ids].sort(), recipient.notify_target, recipient.notify_common])
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.mode === b.mode &&
    a.notifyTarget === b.notifyTarget &&
    a.notifyCommon === b.notifyCommon &&
    JSON.stringify([...a.ruleIds].sort()) === JSON.stringify([...b.ruleIds].sort())
  )
}

type Feedback = { tone: 'ok' | 'error'; text: string } | null

/**
 * S21-07 (F8): one card per recipient. The delivery behaviour is edited in a
 * local draft and saved with PATCH; a 422 from the API (pt-BR) is shown as is.
 */
export function RecipientCard({
  recipient,
  rules,
  digest,
  editing,
  pausing,
  deleting,
  onPause,
  onDelete,
  onEdit,
  onSaved,
}: {
  recipient: Recipient
  rules: Rule[]
  digest: DigestSettings | null
  editing: boolean
  pausing: boolean
  deleting: boolean
  onPause: () => void
  onDelete: () => void
  onEdit: () => void
  onSaved: () => void
}) {
  const { csrfToken } = useAuth()
  const [draft, setDraft] = useState<Draft>(() => draftOf(recipient))
  const [seenSignature, setSeenSignature] = useState(() => signature(recipient))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)

  // The list reloaded with different settings (saved here or elsewhere): the
  // draft follows, so the card never shows stale chips.
  const currentSignature = signature(recipient)
  if (currentSignature !== seenSignature) {
    setSeenSignature(currentSignature)
    setDraft(draftOf(recipient))
  }

  const dirty = !sameDraft(draft, draftOf(recipient))
  const nothing = draft.mode === 'selected' && draft.ruleIds.length === 0
  const noType = !draft.notifyTarget && !draft.notifyCommon
  const previewable = !nothing && !(draft.mode === 'selected' && noType)
  const { preview } = useRecipientPreview(
    {
      rules_mode: draft.mode,
      rule_ids: draft.ruleIds,
      notify_target: draft.notifyTarget,
      notify_common: draft.notifyCommon,
    },
    previewable,
  )

  const toggleRule = (ruleId: number) => {
    setFeedback(null)
    setDraft((current) => ({
      ...current,
      ruleIds: current.ruleIds.includes(ruleId)
        ? current.ruleIds.filter((id) => id !== ruleId)
        : [...current.ruleIds, ruleId],
    }))
  }

  const save = () => {
    if (csrfToken === null) {
      setFeedback({ tone: 'error', text: CSRF_MISSING_MESSAGE })
      return
    }
    setSaving(true)
    setFeedback(null)
    updateRecipient(csrfToken, recipient.id, {
      rules_mode: draft.mode,
      rule_ids: draft.ruleIds,
      notify_target: draft.notifyTarget,
      notify_common: draft.notifyCommon,
    })
      .then(() => {
        setFeedback({ tone: 'ok', text: 'Alterações salvas.' })
        onSaved()
      })
      .catch((error: unknown) =>
        setFeedback({
          tone: 'error',
          text: error instanceof ApiError ? error.message : 'Não foi possível salvar o destinatário.',
        }),
      )
      .finally(() => setSaving(false))
  }

  const sendTest = () => {
    if (csrfToken === null) {
      setFeedback({ tone: 'error', text: CSRF_MISSING_MESSAGE })
      return
    }
    setTesting(true)
    setFeedback(null)
    testNotification(csrfToken, recipient.telegram_chat_id, 'Teste de notificação do teleyes.')
      .then((result) =>
        setFeedback(
          result.delivered
            ? { tone: 'ok', text: 'Mensagem de teste entregue.' }
            : { tone: 'error', text: `Não entregue (${result.status}).` },
        ),
      )
      .catch((error: unknown) =>
        setFeedback({
          tone: 'error',
          text: error instanceof ApiError ? error.message : 'Não foi possível enviar o teste.',
        }),
      )
      .finally(() => setTesting(false))
  }

  const summary = [
    draft.mode === 'all'
      ? `Todas as regras (${rules.length})`
      : `${draft.ruleIds.length} de ${ruleCountLabel(rules.length)}`,
    typesLabel(draft.notifyTarget, draft.notifyCommon),
    preview ? weeklyLabel(preview.alerts_per_week) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

  return (
    <article
      className={editing ? 'plane-pearl recipient-card recipient-card--editing' : 'plane-pearl recipient-card'}
      aria-label={`Destinatário ${recipient.name}`}
    >
      <div className="recipient-card__head">
        <Avatar letter={initial(recipient.name)} />
        <div className="recipient-card__id">
          <h3 className="recipient-card__name">{recipient.name}</h3>
          <p className="recipient-card__chat">
            Chat {recipient.telegram_chat_id}
            {recipient.allowlisted ? '' : ' · não autorizado'}
          </p>
        </div>
        <StatusToggle active={recipient.active} pausing={pausing} onPause={onPause} />
      </div>

      <ModeSegmented
        value={draft.mode}
        label={`Regras de ${recipient.name}`}
        onChange={(mode) => {
          setFeedback(null)
          setDraft({ ...draft, mode })
        }}
      />
      <RuleChips rules={rules} mode={draft.mode} selectedIds={draft.ruleIds} onToggle={toggleRule} />

      <div className="recipient-card__line">
        <span>
          Alvo atingido → <strong>{targetLine(draft.notifyTarget)}</strong>
        </span>
        <DeliverySwitch
          checked={draft.notifyTarget}
          label={`Alvo atingido para ${recipient.name}`}
          onChange={(next) => {
            setFeedback(null)
            setDraft({ ...draft, notifyTarget: next })
          }}
        />
      </div>
      <div className="recipient-card__line">
        <span>
          Match comum → <strong>{commonLine(draft.notifyCommon, digest)}</strong>
        </span>
        <DeliverySwitch
          checked={draft.notifyCommon}
          label={`Match comum para ${recipient.name}`}
          onChange={(next) => {
            setFeedback(null)
            setDraft({ ...draft, notifyCommon: next })
          }}
        />
      </div>

      {nothing && (
        <p className="delivery-warn" role="status">
          Não recebe nada: escolha ao menos uma regra.
        </p>
      )}
      {!nothing && <p className="recipient-card__summary">{summary}</p>}

      <div className="recipient-card__footer">
        {dirty && (
          <>
            <button
              type="button"
              className="plane-action plane-action--compact"
              onClick={save}
              disabled={saving}
            >
              {saving ? 'Salvando…' : 'Salvar alterações'}
            </button>
            <button
              type="button"
              className="plane-action plane-action--secondary plane-action--compact"
              onClick={() => {
                setDraft(draftOf(recipient))
                setFeedback(null)
              }}
              disabled={saving}
            >
              Descartar
            </button>
          </>
        )}
        <button
          type="button"
          className="plane-action plane-action--secondary plane-action--compact"
          onClick={sendTest}
          disabled={testing || !recipient.active || !recipient.allowlisted}
        >
          {testing ? 'Enviando…' : 'Enviar teste'}
        </button>
        <button type="button" className="plane-action plane-action--secondary plane-action--compact" onClick={onEdit}>
          Editar
        </button>
        <button
          type="button"
          className="plane-action plane-action--danger plane-action--compact"
          onClick={onDelete}
          disabled={deleting}
        >
          Excluir
        </button>
      </div>
      {feedback && (
        <p
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          className={
            feedback.tone === 'error'
              ? 'recipient-card__feedback recipient-card__feedback--error'
              : 'recipient-card__feedback'
          }
        >
          {feedback.text}
        </p>
      )}
    </article>
  )
}
