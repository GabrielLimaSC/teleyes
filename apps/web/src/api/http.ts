import { ApiError } from './auth'
import { requestReauth } from '../auth/sessionRecovery'
import { isDemoReadOnly, notifyDemoReadOnly } from './demo'

interface ErrorDetail {
  message: string
  code?: string
  retryAfterSeconds?: number
}

/** `detail` is a plain string for most routes; the setup wizard (S19-02) sends
 * `{code, message, retry_after_seconds?}` so the page can react to the code. */
async function extractDetail(response: Response, fallback: string): Promise<ErrorDetail> {
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && 'detail' in body) {
      const detail = (body as { detail: unknown }).detail
      if (typeof detail === 'string') return { message: detail }
      if (typeof detail === 'object' && detail !== null && 'message' in detail) {
        const structured = detail as { message: unknown; code?: unknown; retry_after_seconds?: unknown }
        if (typeof structured.message === 'string') {
          return {
            message: structured.message,
            code: typeof structured.code === 'string' ? structured.code : undefined,
            retryAfterSeconds:
              typeof structured.retry_after_seconds === 'number' ? structured.retry_after_seconds : undefined,
          }
        }
      }
    }
  } catch {
    // no JSON body — fall through to the generic message
  }
  return { message: fallback }
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
    const {
      message: detail,
      code,
      retryAfterSeconds,
    } = await extractDetail(response, `Erro inesperado (${response.status}).`)
    if (!_isRetry && isWriteRequest(init) && isSessionExpired(response.status, detail)) {
      const freshToken = await requestReauth()
      return apiRequest<T>(path, withFreshCsrfToken(init, freshToken), true)
    }
    // S19-03: a read-only demo refuses every write; the DemoBanner shows the toast.
    if (isDemoReadOnly(response.status, detail)) notifyDemoReadOnly()
    throw new ApiError(detail, response.status, { code, retryAfterSeconds })
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

export function jsonHeaders(csrfToken: string): HeadersInit {
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }
}
