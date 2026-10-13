import { ApiError } from '../api/auth'

/**
 * S13-08: the single place `apiRequest` (api/http.ts) calls into when a
 * *write* comes back 401 or "invalid csrf token" — instead of leaking that
 * raw backend detail into whatever form happened to be open, it asks this
 * module for a fresh CSRF token and retries. `AuthContext` is the only
 * thing that ever registers a handler (it owns the modal + the actual
 * `/auth/login` call); keeping the registration indirect like this lets a
 * plain function (`apiRequest`) reach into a piece of UI state without
 * importing React or the context module, and keeps every mutating call
 * site free of its own try/catch-and-prompt logic.
 */
export type ReauthHandler = () => Promise<string>

let handler: ReauthHandler | null = null
let pending: Promise<string> | null = null

export function registerReauthHandler(fn: ReauthHandler | null): void {
  handler = fn
}

/**
 * Resolves with a fresh CSRF token once the admin has re-entered their
 * password (via the modal `AuthContext` renders), or rejects with a
 * friendly, already-composed message if that never happens. Concurrent
 * callers (e.g. two writes failing back-to-back) share one in-flight
 * attempt instead of prompting twice.
 */
export function requestReauth(): Promise<string> {
  if (handler === null) {
    return Promise.reject(
      new ApiError('Sessão expirada. Recarregue a página e faça login de novo.', 401),
    )
  }
  if (pending === null) {
    pending = handler().finally(() => {
      pending = null
    })
  }
  return pending
}

export const CSRF_BROADCAST_KEY = 'teleyes.csrf_broadcast'

/**
 * Pings other tabs that a fresh CSRF token exists (fresh login or a reauth
 * after an expired session) so they can adopt it and clear any stale
 * "sessão expirou" state of their own — without prompting the admin for
 * their password a second time in a tab they weren't looking at. Read by
 * `AuthContext`'s `storage` listener.
 */
export function broadcastCsrfToken(token: string): void {
  try {
    // The `at` field forces a changed value even on the rare chance the
    // token string repeats, so the `storage` event always fires in other
    // tabs.
    window.localStorage.setItem(CSRF_BROADCAST_KEY, JSON.stringify({ token, at: Date.now() }))
  } catch {
    // Storage blocked/full: this tab's own token is already set correctly
    // (see AuthContext); only the other-tabs convenience is lost.
  }
}
