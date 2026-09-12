import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthContext'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()

  if (status === 'checking') return null
  if (status === 'anonymous') return <Navigate to="/" replace />
  return <>{children}</>
}
