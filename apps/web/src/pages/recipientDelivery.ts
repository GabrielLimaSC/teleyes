import type { DigestSettings, Recipient, Rule } from '../api/types'

/** S21-07: wording shared by the recipient cards, the rail form and the rules table. */

export function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

export function recipientsLabel(names: string[]): { text: string; none: boolean } {
  if (names.length === 0) return { text: 'ninguém recebe', none: true }
  if (names.length === 1) return { text: `só ${names[0]}`, none: false }
  return { text: `${names.length} pessoas`, none: false }
}

export function targetLine(notifyTarget: boolean): string {
  return notifyTarget ? 'ping imediato' : 'desligado'
}

/** The channel of a common match comes from the global delivery policy. */
export function commonLine(notifyCommon: boolean, digest: DigestSettings | null): string {
  if (!notifyCommon) return 'desligado'
  if (digest?.enabled) return `no digest ${digest.send_at_local.slice(0, 5)}`
  return 'imediato'
}

export function typesLabel(notifyTarget: boolean, notifyCommon: boolean): string {
  if (notifyTarget && notifyCommon) return 'alvos e matches comuns'
  if (notifyTarget) return 'só alvos atingidos'
  if (notifyCommon) return 'só matches comuns'
  return 'nenhum tipo de alerta'
}

export function weeklyLabel(count: number): string {
  if (count === 0) return 'nenhum alerta na última semana'
  return `~${count} ${count === 1 ? 'alerta' : 'alertas'}/semana`
}

export function ruleCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'regra' : 'regras'}`
}

/** Active recipients in "escolher" mode that do not receive `rule`. */
export function recipientsMissingRule(recipients: Recipient[], rule: Rule): Recipient[] {
  return recipients.filter(
    (recipient) =>
      recipient.active && recipient.rules_mode === 'selected' && !recipient.rule_ids.includes(rule.id),
  )
}
