import type { UnappliedChange } from '../api/listener'

const FIELD_LABEL: Record<string, string> = {
  target_price: 'preço-alvo',
  max_price: 'preço máximo',
  terms: 'termos',
  chat: 'endereço',
}

const NOUN = { rule: 'regra', source: 'grupo', recipient: 'destinatário' } as const
const NEW_NOUN = { rule: 'nova regra', source: 'novo grupo', recipient: 'novo destinatário' } as const

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`
}

/** One change in a few words: "preço-alvo de Fone bluetooth", "nova regra SSD NVMe". */
export function describeChange(change: UnappliedChange): string {
  const { entity, action, name } = change
  switch (action) {
    case 'created':
      return `${NEW_NOUN[entity]} ${name}`
    case 'activated':
      return `${NOUN[entity]} ${name} ativada`
    case 'paused':
      return `${NOUN[entity]} ${name} pausada`
    case 'deleted':
      return `${NOUN[entity]} ${name} removida`
    case 'edited': {
      const fields = change.fields.map((field) => FIELD_LABEL[field] ?? field)
      return fields.length === 0 ? `${NOUN[entity]} ${name} editada` : `${joinList(fields)} de ${name}`
    }
  }
}

const MAX_LISTED = 3

export interface PendingSummary {
  /** "2 mudanças não aplicadas"; "Há mudanças não aplicadas" when the detail is unknown. */
  title: string
  /** "preço-alvo de Fone bluetooth e nova regra SSD NVMe"; empty when unknown. */
  detail: string
}

/** S25-F4: the amber strip's text, from what the API says differs from the applied config. */
export function summarizePending(changes: UnappliedChange[]): PendingSummary {
  if (changes.length === 0) return { title: 'Há mudanças não aplicadas', detail: '' }
  const shown = changes.slice(0, MAX_LISTED).map(describeChange)
  const rest = changes.length - shown.length
  if (rest > 0) shown.push(rest === 1 ? '1 outra mudança' : `${rest} outras mudanças`)
  return {
    title: changes.length === 1 ? '1 mudança não aplicada' : `${changes.length} mudanças não aplicadas`,
    detail: joinList(shown),
  }
}
