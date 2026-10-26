import type { Match, Rule } from '../api/types'
import { cardTitle } from '../components/matchTitle'

/** Route of the Economia page (the "Marcar como comprado" actions navigate here). */
export const ECONOMIA_PATH = '/economia'

/** What the "Registrar compra" form starts with. */
export interface PurchaseDraft {
  name: string
  /** Price already in cents, e.g. the price of the match being marked as bought. */
  priceCents: number | null
  productKey: string | null
  ruleId: number | null
  /** Label shown for the link (the product title or rule name). */
  linkLabel: string | null
}

/** Router state carried by "Marcar como comprado". */
export interface EconomiaNavState {
  prefill?: PurchaseDraft
}

export const EMPTY_DRAFT: PurchaseDraft = {
  name: '',
  priceCents: null,
  productKey: null,
  ruleId: null,
  linkLabel: null,
}

/** The pre-fill of "Marcar como comprado" on a card: product, rule and price of the match. */
export function draftFromMatch(match: Match, rule: Rule | undefined): PurchaseDraft {
  const title = (match as { display_name?: string | null }).display_name ?? cardTitle(match.message_text, rule)
  const name = title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title
  return {
    name,
    priceCents: match.price_cents,
    productKey: match.product_key,
    ruleId: match.rule_id,
    linkLabel: name,
  }
}

/** A search result when linking a purchase to something the app watches. */
export interface LinkOption {
  kind: 'product' | 'rule'
  productKey: string | null
  ruleId: number | null
  label: string
}

export interface PurchaseFormValues {
  name: string
  price: string
  day: string
  store: string
  productKey: string | null
  ruleId: number | null
  linkLabel: string | null
}

export function valuesFromDraft(draft: PurchaseDraft, day: string, store = ''): PurchaseFormValues {
  return {
    name: draft.name,
    price: draft.priceCents === null ? '' : (draft.priceCents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
    day,
    store,
    productKey: draft.productKey,
    ruleId: draft.ruleId,
    linkLabel: draft.linkLabel,
  }
}
