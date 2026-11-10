import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { GoalPace, GoalReport, SavingsGoalInput } from '../api/purchases'
import { parsePriceInput } from '../utils/priceInput'
import { toDateInputValue } from '../utils/dates'
import { formatCurrency, formatSigned } from '../utils/savings'
import { useModalMotion } from '../motion/modalMotion'
import { DIALOG_PRESET } from '../motion/waapi'
import '../components/ConfirmDialog.css'

export const PACE_LABEL: Record<GoalPace, string> = {
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
        <div className="economia-tile__value">Sem meta definida</div>
        <p className="economia-tile__detail">
          Defina quanto quer economizar e até quando. O teleyes mostra o ritmo e quanto cada compra contribuiu.
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
  sheet = false,
}: {
  /** Phone: render only the form (the BottomSheet provides backdrop, title and Esc). */
  sheet?: boolean
  current: GoalReport | null
  submitting: boolean
  error: string | null
  onSubmit: (input: SavingsGoalInput) => void
  onRemove: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const amountRef = useRef<HTMLInputElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLFormElement>(null)
  // S25-M1: no backdrop in the phone sheet (the BottomSheet moves it).
  useModalMotion(backdropRef, panelRef, DIALOG_PRESET, !sheet)
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
    if (sheet) return
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [submitting, onCancel, sheet])

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
  const formClass = sheet
    ? 'economia-goal-dialog economia-goal-dialog--sheet'
    : 'plane-pearl confirm-dialog economia-goal-dialog'
  const dialog = (
      <form
        ref={panelRef}
        className={formClass}
        role={sheet ? undefined : 'dialog'}
        aria-modal={sheet ? undefined : true}
        aria-labelledby={titleId}
        onSubmit={submit}
        noValidate
      >
        <h2 id={titleId} className={sheet ? 'sr-only' : undefined}>
          {current === null ? 'Definir meta de economia' : 'Editar meta de economia'}
        </h2>
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
  )
  if (sheet) return dialog
  return createPortal(
    <div ref={backdropRef} className="confirm-dialog__backdrop" role="presentation">
      {dialog}
    </div>,
    document.body,
  )
}
