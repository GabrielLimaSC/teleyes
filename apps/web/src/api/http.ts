import { ApiError } from './auth'

async function extractDetail(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (
      typeof body === 'object' &&
      body !== null &&
      'detail' in body &&
      typeof (body as { detail: unknown }).detail === 'string'
    ) {
      return (body as { detail: string }).detail
    }
  } catch {
    // no JSON body — fall through to the generic message
  }
  return fallback
}

/**
 * Every mutating call in the app goes through this so 404/409/422 responses
 * surface the API's real `detail` message instead of a generic one — that's
 * the whole point of S4-06's `done_when` around clear error feedback.
 */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const detail = await extractDetail(response, `Erro inesperado (${response.status}).`)
    throw new ApiError(detail, response.status)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

export function jsonHeaders(csrfToken: string): HeadersInit {
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }
}
