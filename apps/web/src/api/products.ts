import { apiRequest } from './http'
import type { Product, ProductHistoryRange, RuleSuggestion } from './types'

/** S14-08: `GET /products/{key}?range=` (backend from S14-01). `key` travels
 * URL-encoded — it is derived from free text (`packages/rules/product.py`),
 * never guaranteed to be URL-safe on its own. A missing product surfaces as
 * an `ApiError` with `status === 404` (same pattern as every other client),
 * left for the caller (`ProductPanel`) to turn into a "não encontrado" state. */
export const fetchProduct = (key: string, range: ProductHistoryRange = '90d'): Promise<Product> =>
  apiRequest<Product>(`/products/${encodeURIComponent(key)}?range=${range}`)

/** S14-09: `GET /products/{key}/rule-suggestion` — prefill for "nova regra a
 * partir do produto" (F2). Same 404-as-`ApiError` contract as `fetchProduct`. */
export const fetchRuleSuggestion = (productKey: string): Promise<RuleSuggestion> =>
  apiRequest<RuleSuggestion>(`/products/${encodeURIComponent(productKey)}/rule-suggestion`)
