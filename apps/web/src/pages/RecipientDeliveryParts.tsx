import type { Rule, RulesMode } from '../api/types'
import './RecipientDelivery.css'

/** S21-07: small building blocks shared by the recipient card and the rail form. */

export function ModeSegmented({
  value,
  onChange,
  label,
}: {
  value: RulesMode
  onChange: (mode: RulesMode) => void
  label: string
}) {
  return (
    <div className="delivery-seg" role="group" aria-label={label}>
      <button
        type="button"
        className={value === 'all' ? 'delivery-seg__opt delivery-seg__opt--on' : 'delivery-seg__opt'}
        aria-pressed={value === 'all'}
        onClick={() => onChange('all')}
      >
        Todas as regras
      </button>
      <button
        type="button"
        className={value === 'selected' ? 'delivery-seg__opt delivery-seg__opt--on' : 'delivery-seg__opt'}
        aria-pressed={value === 'selected'}
        onClick={() => onChange('selected')}
      >
        Escolher regras
      </button>
    </div>
  )
}

export function DeliverySwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? 'delivery-switch delivery-switch--on' : 'delivery-switch'}
      onClick={() => onChange(!checked)}
    >
      <span className="delivery-switch__knob" />
    </button>
  )
}

export function RuleChips({
  rules,
  mode,
  selectedIds,
  onToggle,
}: {
  rules: Rule[]
  mode: RulesMode
  selectedIds: number[]
  onToggle: (ruleId: number) => void
}) {
  if (rules.length === 0) return <p className="delivery-muted">Nenhuma regra criada ainda.</p>
  const choosing = mode === 'selected'
  return (
    <ul className="delivery-chips" aria-label="Regras deste destinatário">
      {rules.map((rule) => {
        const on = !choosing || selectedIds.includes(rule.id)
        return (
          <li key={rule.id}>
            <button
              type="button"
              className={on ? 'delivery-chip delivery-chip--on' : 'delivery-chip'}
              aria-pressed={on}
              disabled={!choosing}
              onClick={() => onToggle(rule.id)}
            >
              {rule.name}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function Avatar({ letter, title }: { letter: string; title?: string }) {
  return (
    <span className="delivery-avatar" aria-hidden="true" title={title}>
      {letter}
    </span>
  )
}
