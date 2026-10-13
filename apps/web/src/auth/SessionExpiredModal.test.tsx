import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './AuthContext'
import { requestReauth } from './sessionRecovery'

const STORAGE_KEY = 'teleyes.csrf_token'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Stands in for a real page's half-filled form (e.g. RegrasPage's "Nova
 * regra" rail) — plain local state, exactly what would be lost by a full
 * page reload. */
function FormUnderTest() {
  const [name, setName] = useState('')
  return <input aria-label="Nome da regra" value={name} onChange={(event) => setName(event.target.value)} />
}

afterEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

describe('SessionExpiredModal (S13-08)', () => {
  it('shows a clear message (never the raw backend detail) and keeps the underlying form untouched', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'tok-old')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ admin_id: 1 }))

    render(
      <AuthProvider>
        <FormUnderTest />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByLabelText('Nome da regra')).toBeInTheDocument())

    await userEvent.type(screen.getByLabelText('Nome da regra'), 'RTX 5070 ainda não salva')

    const reauthResult = requestReauth()
    reauthResult.catch(() => {})

    const dialog = await screen.findByRole('dialog', { name: 'Sua sessão expirou' })
    expect(dialog).toHaveTextContent(/digite sua senha/i)
    // The raw backend strings this task exists to hide.
    expect(screen.queryByText(/invalid csrf token/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/not authenticated/i)).not.toBeInTheDocument()

    // The form underneath is still mounted with what was typed — no reload
    // happened.
    expect(screen.getByLabelText('Nome da regra')).toHaveValue('RTX 5070 ainda não salva')

    // Settle the pending reauth so `sessionRecovery`'s module-level state
    // doesn't leak into the next test (its own `AuthProvider`'s handler
    // would otherwise never get a chance to run).
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await expect(reauthResult).rejects.toThrow()
  })

  it('a wrong password shows an inline error and keeps the modal open', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'tok-old')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ admin_id: 1 })) // /auth/me on mount
      .mockResolvedValueOnce(jsonResponse({ detail: 'invalid credentials' }, 401)) // /auth/login

    render(
      <AuthProvider>
        <FormUnderTest />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByLabelText('Nome da regra')).toBeInTheDocument())

    const reauthResult = requestReauth()
    reauthResult.catch(() => {})
    await screen.findByRole('dialog')

    await userEvent.type(screen.getByLabelText('Senha'), 'senha-errada')
    await userEvent.click(screen.getByRole('button', { name: 'Entrar e continuar' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Senha incorreta.')
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // Settle the pending reauth (see the first test's comment for why).
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await expect(reauthResult).rejects.toThrow()
  })

  it('the right password closes the modal and lets the action be retried', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'tok-old')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ admin_id: 1 })) // /auth/me on mount
      .mockResolvedValueOnce(jsonResponse({ csrf_token: 'tok-fresh' })) // /auth/login
      .mockResolvedValueOnce(jsonResponse({ admin_id: 1 })) // /auth/me after login

    render(
      <AuthProvider>
        <FormUnderTest />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByLabelText('Nome da regra')).toBeInTheDocument())
    await userEvent.type(screen.getByLabelText('Nome da regra'), 'Termo pendente')

    const reauthResult = requestReauth()
    await screen.findByRole('dialog')

    await userEvent.type(screen.getByLabelText('Senha'), 'senha-correta')
    await userEvent.click(screen.getByRole('button', { name: 'Entrar e continuar' }))

    await expect(reauthResult).resolves.toBe('tok-fresh')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // Still there, untouched — the caller (apiRequest) is the one that
    // retries the write with the fresh token; the form itself never reset.
    expect(screen.getByLabelText('Nome da regra')).toHaveValue('Termo pendente')
  })

  it('Cancelar closes the modal without logging in', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'tok-old')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ admin_id: 1 }))

    render(
      <AuthProvider>
        <FormUnderTest />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByLabelText('Nome da regra')).toBeInTheDocument())

    const reauthResult = requestReauth()
    reauthResult.catch(() => {})
    await screen.findByRole('dialog')

    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await expect(reauthResult).rejects.toThrow()
  })
})
