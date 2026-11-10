import type { Rule } from '../api/types'
import { formatDayMonthTime } from './dates'

/** S25-F4: the rule's silence in the status column — "silenciada até 06/11 14:30"
 * or "silenciada até reativar"; `null` when the rule is not silenced. */
export function ruleSilenceLabel(rule: Pick<Rule, 'snoozed_until' | 'snoozed_indefinitely'>): string | null {
  if (rule.snoozed_indefinitely) return 'silenciada até reativar'
  if (rule.snoozed_until) return `silenciada até ${formatDayMonthTime(rule.snoozed_until)}`
  return null
}

/** Toast after silencing, from the chosen duration. */
export function snoozeToast(duration: number | 'indefinite'): string {
  if (duration === 'indefinite') return 'Regra silenciada até reativar.'
  return duration === 1 ? 'Regra silenciada por 24 h.' : `Regra silenciada por ${duration} dias.`
}
