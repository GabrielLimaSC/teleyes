import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { GoalPace, GoalReport, SavingsGoalInput } from '../api/purchases'
import { parsePriceInput } from '../utils/priceInput'
import { toDateInputValue } from '../utils/dates'
import { formatCurrency, formatSigned } from '../utils/savings'
import '../components/ConfirmDialog.css'

const PACE_LABEL: Record<GoalPace, string> = {
  done: 'concluída',
  on_track: 'no prazo',
  behind: 'atrasado',
  expired: 'prazo encerrado',
}

/** "2026-12-31" -> "31/12" (no Date parsing, so the timezone never shifts the day). */
export function goalDay(deadline: string): string {
  const [, month, day] = deadline.split('-')
  return `${day}/${month}`
}

/** Bar fill in 0..100: the API reports the real ratio, only the display is clamped. */
export function goalBarPct(goal: GoalReport): number {
  return Math.min(100, Math.max(0, goal.pct))
}

function daysText(days: number): string {
  return `${days} ${days === 1 ? 'dia' : 'dias'}`
}

/** Third summary card: the savings goal (S21-08). Honest when the estimate is negative. */
export function GoalCard({
  goal,
  onDefine,
  onEdit,
}: {
  goal: GoalReport | null
  onDefine: () => void
  onEdit: () => void
}) {
  if (goal === null) {
    return (
      <div className="plane-pearl economia-tile economia-goal">
        <div className="economia-tile__label">Meta de economia</div>
        <p className="economia-tile__detail">
          Defina quanto quer economizar e até quando: o teleyes mostra o quanto já foi e se o ritmo cabe no prazo.
        </p>
        <button type="button" className="plane-action plane-action--secondary" onClick={onDefine}>
          Definir meta
        </button>
      </div>
    )
  }
  const negative = goal.saved_cents < 0
  const shown = Math.round(goalBarPct(goal))
  return (
    <div className="plane-pearl economia-tile economia-goal">
      <div className="economia-goal__head">
        <div className="economia-tile__label">Meta de economia</div>
        <button type="button" className="economia-goal__edit" onClick={onEdit}>
          editar
        </button>
      </div>
      <div className="economia-tile__value">
        {shown}% de {formatCurrency(goal.amount_cents)}
      </div>
      <div
        className="economia-goal__track"
        role="progressbar"
        aria-label="Progresso da meta de economia"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown}
      >
        <span className="economia-goal__fill" style={{ width: `${goalBarPct(goal)}%` }} />
      </div>
      <div className="economia-tile__detail">
        {goal.pace === 'done'
          ? 'Meta atingida.'
          : `Faltam ${formatCurrency(goal.remaining_cents)} até ${goalDay(goal.deadline)}${
              goal.pace === 'expired' ? '' : ` · ${daysText(goal.days_left)}`
            }`}
      </div>
      <div className="economia-tile__detail">
        {negative
          ? `Economia estimada negativa até agora (${formatSigned(goal.saved_cents)}).`
          : `${formatCurrency(goal.saved_cents)} economizados`}
        {' · '}
        <span className={`economia-goal__pace economia-goal__pace--${goal.pace}`}>
          ritmo: {PACE_LABEL[goal.pace]}
        </span>
      </div>
    </div>
  )
}

/** "Definir meta" / "Editar meta": amount + deadline, with "Remover meta" when one exists. */
export function GoalDialog({
  current,
  submitting,
  error,
  onSubmit,
  onRemove,
  onCancel,
}: {
  current: GoalReport | null
  submitting: boolean
  error: string | null
  onSubmit: (input: SavingsGoalInput) => void
  onRemove: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const amountRef = useRef<HTMLInputElement>(null)
  const [amount, setAmount] = useState(
    current === null ? '' : (current.amount_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
  )
  const [day, setDay] = useState(current?.deadline ?? '')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const today = toDateInputValue(new Date())

  useEffect(() => {
    amountRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [submitting, onCancel])

  function submit(event: FormEvent) {
    event.preventDefault()
    const price = parsePriceInput(amount)
    if (price.error !== null) {
      setFieldError(price.error.replace('Preço', 'Valor'))
      return
    }
    if (price.cents <= 0) {
      setFieldError('O valor da meta precisa ser maior que zero.')
      return
    }
    if (day === '') {
      setFieldError('Informe até quando.')
      return
    }
    if (day <= today) {
      setFieldError('O prazo precisa estar no futuro.')
      return
    }
    setFieldError(null)
    onSubmit({ amount_cents: price.cents, deadline: day })
  }

  const shownError = fieldError ?? error
  return createPortal(
    <div className="confirm-dialog__backdrop" role="presentation">
      <form
        className="plane-pearl confirm-dialog economia-goal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        noValidate
      >
        <h2 id={titleId}>{current === null ? 'Definir meta de economia' : 'Editar meta de economia'}</h2>
        <label>
          Quanto quer economizar (R$)
          <input
            ref={amountRef}
            value={amount}
            inputMode="decimal"
            placeholder="2.000,00"
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label>
          Até quando
          <input type="date" value={day} min={today} onChange={(event) => setDay(event.target.value)} />
        </label>
        {shownError && (
          <p role="alert" className="economia-form__error">
            {shownError}
          </p>
        )}
        <div className="confirm-dialog__actions">
          {current !== null && (
            <button type="button" className="plane-action plane-action--secondary" onClick={onRemove} disabled={submitting}>
              Remover meta
            </button>
          )}
          <button type="button" className="plane-action plane-action--secondary" onClick={onCancel} disabled={submitting}>
            Cancelar
          </button>
          <button type="submit" className="plane-action" disabled={submitting}>
            {submitting ? 'Salvando…' : 'Salvar meta'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
