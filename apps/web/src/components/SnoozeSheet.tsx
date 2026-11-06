import { useId, useState } from 'react'
import type { SnoozeDuration } from '../api/snoozes'
import { BottomSheet } from './BottomSheet'
import './SnoozeSheet.css'

const dayMonth = (date: Date): string =>
  date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })

const clock = (date: Date): string =>
  date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

/** S26-a (39): the computed deadline under each option. */
export function snoozeOptions(now: Date): { value: SnoozeDuration; label: string; hint: string }[] {
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000)
  const week = new Date(now.getTime() + 7 * 24 * 3600 * 1000)
  return [
    { value: 1, label: 'Por 24 horas', hint: `até amanhã, ${clock(tomorrow)}` },
    { value: 7, label: 'Por 7 dias', hint: `até ${dayMonth(week)}` },
    { value: 'indefinite', label: 'Até reativar', hint: 'fica silenciada até você ligar de novo' },
  ]
}

/** S26-a (39): phone sheet to silence a rule: radio list, deadline preview, target-price note. */
export function SnoozeSheet({
  ruleName,
  open,
  busy,
  onClose,
  onConfirm,
}: {
  ruleName: string
  open: boolean
  busy: boolean
  onClose: () => void
  onConfirm: (duration: SnoozeDuration) => void
}) {
  const name = useId()
  const [choice, setChoice] = useState<SnoozeDuration>(1)
  const options = snoozeOptions(new Date())
  return (
    <BottomSheet open={open} onClose={onClose} title={`Silenciar “${ruleName}”`}>
      <div className="snooze-sheet">
        <p className="snooze-sheet__sub">ofertas comuns desta regra param de chegar</p>
        <div role="radiogroup" aria-label="Por quanto tempo" className="snooze-sheet__options">
          {options.map((option) => (
            <label key={String(option.value)} className="snooze-sheet__option">
              <input
                type="radio"
                name={name}
                checked={choice === option.value}
                onChange={() => setChoice(option.value)}
              />
              <span className="snooze-sheet__text">
                <span className="snooze-sheet__label">{option.label}</span>
                <span className="snooze-sheet__hint">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="snooze-sheet__note">Preço-alvo atingido continua chegando na hora.</p>
        <div className="snooze-sheet__actions">
          <button type="button" className="plane-action plane-action--secondary" onClick={onClose}>
            Voltar
          </button>
          <button type="button" className="plane-action" disabled={busy} onClick={() => onConfirm(choice)}>
            {busy ? 'Salvando…' : 'Silenciar'}
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
