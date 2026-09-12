import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchCurrentAdmin, login as apiLogin, logout as apiLogout } from '../api/auth'

const CSRF_STORAGE_KEY = 'teleyes.csrf_token'

type AuthStatus = 'checking' | 'authenticated' | 'anonymous'

interface AuthContextValue {
  status: AuthStatus
  adminId: number | null
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  /** True once a reload lost the CSRF token (session cookie still valid, but
   * logout needs a fresh login first — GET /auth/me has no way to hand back a
   * token, only POST /auth/login does). */
  csrfMissing: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('checking')
  const [adminId, setAdminId] = useState<number | null>(null)
  const [csrfToken, setCsrfToken] = useState<string | null>(() =>
    sessionStorage.getItem(CSRF_STORAGE_KEY),
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

  const login = useCallback(async (password: string) => {
    const { csrf_token } = await apiLogin(password)
    sessionStorage.setItem(CSRF_STORAGE_KEY, csrf_token)
    setCsrfToken(csrf_token)
    const me = await fetchCurrentAdmin()
    setAdminId(me?.admin_id ?? null)
    setStatus('authenticated')
  }, [])

  const logout = useCallback(async () => {
    if (csrfToken === null) {
      throw new Error('Sessão sem token CSRF em memória — faça login de novo para poder sair.')
    }
    await apiLogout(csrfToken)
    sessionStorage.removeItem(CSRF_STORAGE_KEY)
    setCsrfToken(null)
    setAdminId(null)
    setStatus('anonymous')
  }, [csrfToken])

  const value = useMemo<AuthContextValue>(
    () => ({ status, adminId, login, logout, csrfMissing: status === 'authenticated' && csrfToken === null }),
    [status, adminId, login, logout, csrfToken],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (context === null) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
