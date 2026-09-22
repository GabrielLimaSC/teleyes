import { ApiError } from './auth'
import { requestReauth } from '../auth/sessionRecovery'

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

function isWriteRequest(init: RequestInit): boolean {
  const method = init.method?.toUpperCase()
  return method !== undefined && method !== 'GET' && method !== 'HEAD'
}

/** S13-08: a 401 always means "no valid session"; a 403 only means the same
 * thing when it's specifically the CSRF check failing — other 403s (e.g. a
 * future permission rule) must not trigger a reauth prompt. */
function isSessionExpired(status: number, detail: string): boolean {
  return status === 401 || (status === 403 && detail === 'invalid csrf token')
}

function withFreshCsrfToken(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers)
  if (headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token)
  return { ...init, headers }
}

/**
 * Every mutating call in the app goes through this so 404/409/422 responses
 * surface the API's real `detail` message instead of a generic one — that's
 * the whole point of S4-06's `done_when` around clear error feedback.
 *
 * S13-08: it's also the one place that notices a *write* came back with an
 * expired session or a stale CSRF token (401, or 403 "invalid csrf token")
 * — instead of throwing that raw detail at whichever page happened to be
 * open, it asks `sessionRecovery` for a fresh token (which pops the
 * "sessão expirou" modal) and retries the exact same request once. Callers
 * never see the expired-session failure at all when reauth succeeds; they
 * only see a rejection if the admin cancels or reauth itself fails.
 */
export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  _isRetry = false,
): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const detail = await extractDetail(response, `Erro inesperado (${response.status}).`)
    if (!_isRetry && isWriteRequest(init) && isSessionExpired(response.status, detail)) {
      const freshToken = await requestReauth()
      return apiRequest<T>(path, withFreshCsrfToken(init, freshToken), true)
    }
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
