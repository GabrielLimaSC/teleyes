import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, fetchCurrentAdmin, login as apiLogin, logout as apiLogout } from '../api/auth'
import { SessionExpiredModal } from './SessionExpiredModal'
import {
  CSRF_BROADCAST_KEY,
  broadcastCsrfToken,
  registerReauthHandler,
} from './sessionRecovery'

const CSRF_STORAGE_KEY = 'teleyes.csrf_token'

// S12-04: a browser that blocks web storage makes every `sessionStorage` call
// throw (even reading the property can), and an uncaught throw in the state
// initializer blanked the whole app. Storage is only a convenience that keeps
// the CSRF token across a reload; the source of truth is `GET /auth/me`
// (S20-01), which hands the token back, so even without storage a reload or a
// new tab recovers it.
function readStoredCsrfToken(): string | null {
  try {
    return window.sessionStorage.getItem(CSRF_STORAGE_KEY)
  } catch {
    return null
  }
}

function storeCsrfToken(token: string | null): void {
  try {
    if (token === null) window.sessionStorage.removeItem(CSRF_STORAGE_KEY)
    else window.sessionStorage.setItem(CSRF_STORAGE_KEY, token)
  } catch {
    // Blocked or full storage: the token stays in memory for this page only.
  }
}

export const CSRF_MISSING_MESSAGE =
  'Sessão sem token de segurança em memória — atualize a página e faça login de novo.'

type AuthStatus = 'checking' | 'authenticated' | 'anonymous'

interface AuthContextValue {
  status: AuthStatus
  adminId: number | null
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  /** For mutating calls (rules/sources/recipients CRUD). Recovered from
   * `GET /auth/me` after any reload; null only while anonymous/checking. */
  csrfToken: string | null
  /** S13-08: a write came back with an expired session or CSRF mismatch —
   * `SessionExpiredModal` (mounted below) reads this to show itself. */
  sessionExpired: boolean
  /** Dismisses the modal without logging back in; the write that triggered
   * it ends up rejected with a friendly message instead of retried. */
  cancelReauth: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('checking')
  const [adminId, setAdminId] = useState<number | null>(null)
  const [csrfToken, setCsrfToken] = useState<string | null>(readStoredCsrfToken)
  const [sessionExpired, setSessionExpired] = useState(false)
  // S13-08: the promise `sessionRecovery.requestReauth()` is waiting on —
  // resolved by a successful `login()` call (modal submit, or another tab's
  // reauth arriving over `storage`), rejected by `cancelReauth`.
  const reauthWaiterRef = useRef<{ resolve: (token: string) => void; reject: (error: Error) => void } | null>(
    null,
  )

  useEffect(() => {
    let cancelled = false
    fetchCurrentAdmin()
      .then((me) => {
        if (cancelled) return
        if (me === null) {
          setStatus('anonymous')
          setAdminId(null)
        } else {
          storeCsrfToken(me.csrf_token)
          setCsrfToken(me.csrf_token)
          setStatus('authenticated')
          setAdminId(me.admin_id)
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('anonymous')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Shared by the normal login form (LoginPage) and the reauth modal
  // (SessionExpiredModal) — either way, a successful call means a fresh
  // CSRF token now exists, so both flows resolve any pending write that was
  // waiting on `sessionRecovery.requestReauth()` and tell other tabs about
  // the new token.
  const login = useCallback(async (password: string) => {
    const { csrf_token } = await apiLogin(password)
    storeCsrfToken(csrf_token)
    setCsrfToken(csrf_token)
    const me = await fetchCurrentAdmin()
    setAdminId(me?.admin_id ?? null)
    setStatus('authenticated')
    setSessionExpired(false)
    broadcastCsrfToken(csrf_token)
    reauthWaiterRef.current?.resolve(csrf_token)
    reauthWaiterRef.current = null
  }, [])

  const logout = useCallback(async () => {
    // S20-01: never leave the user stuck. A 401/403 means the session is
    // already gone (api restarted, expired) or the token is stale — either
    // way the local state must be cleared and the login shown.
    let failure: unknown = null
    if (csrfToken !== null) {
      try {
        await apiLogout(csrfToken)
      } catch (error) {
        const rejected = error instanceof ApiError && (error.status === 401 || error.status === 403)
        if (!rejected) failure = error
      }
    }
    if (failure !== null) throw failure
    storeCsrfToken(null)
    setCsrfToken(null)
    setAdminId(null)
    setStatus('anonymous')
  }, [csrfToken])

  const cancelReauth = useCallback(() => {
    setSessionExpired(false)
    reauthWaiterRef.current?.reject(
      new Error('Reautenticação cancelada — tente a ação de novo quando quiser.'),
    )
    reauthWaiterRef.current = null
  }, [])

  // S13-08: registers the function `apiRequest` (api/http.ts) calls through
  // `sessionRecovery.requestReauth()` when a write's session/CSRF expired.
  // Opening the modal and resolving/rejecting the returned promise are the
  // only jobs here — `login`/`cancelReauth` above do the rest.
  useEffect(() => {
    registerReauthHandler(
      () =>
        new Promise<string>((resolve, reject) => {
          reauthWaiterRef.current = { resolve, reject }
          setSessionExpired(true)
        }),
    )
    return () => registerReauthHandler(null)
  }, [])

  // Multi-tab: another tab reauthenticated (or just logged in fresh) and
  // broadcast its new token. Adopt it here too, and if this tab is showing
  // its own "sessão expirou" modal (or has a write waiting on one), clear
  // it instead of leaving a stale prompt/error behind — see CLAUDE.md's
  // "não sobre-engenhar": this does not attempt to also retry this tab's
  // in-flight write transparently beyond resolving the waiter, which is
  // exactly what a same-tab reauth already does.
  useEffect(() => {
    function onStorage(event: StorageEvent): void {
      if (event.key !== CSRF_BROADCAST_KEY || event.newValue === null) return
      let token: string
      try {
        token = (JSON.parse(event.newValue) as { token: string }).token
      } catch {
        return
      }
      storeCsrfToken(token)
      setCsrfToken(token)
      setSessionExpired(false)
      reauthWaiterRef.current?.resolve(token)
      reauthWaiterRef.current = null
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      adminId,
      login,
      logout,
      csrfToken,
      sessionExpired,
      cancelReauth,
    }),
    [status, adminId, login, logout, csrfToken, sessionExpired, cancelReauth],
  )

  return (
    <AuthContext.Provider value={value}>
      {children}
      <SessionExpiredModal />
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (context === null) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
