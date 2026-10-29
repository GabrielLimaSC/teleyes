export class ApiError extends Error {
  status: number
  /** S19-02: the machine-readable code of the setup wizard's errors (`/setup/*`). */
  code?: string
  /** S19-02: seconds to wait, when the server rate limited the action or Telegram asked to. */
  retryAfterSeconds?: number

  constructor(message: string, status: number, extra: { code?: string; retryAfterSeconds?: number } = {}) {
    super(message)
    this.status = status
    this.code = extra.code
    this.retryAfterSeconds = extra.retryAfterSeconds
  }
}

export interface LoginResponse {
  csrf_token: string
}

export interface MeResponse {
  admin_id: number
  csrf_token: string
}

export async function login(password: string): Promise<LoginResponse> {
  const response = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!response.ok) {
    throw new ApiError(
      response.status === 401 ? 'Senha incorreta.' : 'Não foi possível entrar agora.',
      response.status,
    )
  }
  return (await response.json()) as LoginResponse
}

export async function fetchCurrentAdmin(): Promise<MeResponse | null> {
  const response = await fetch('/auth/me', { credentials: 'same-origin' })
  if (response.status === 401) return null
  if (!response.ok) throw new ApiError('Não foi possível confirmar a sessão.', response.status)
  return (await response.json()) as MeResponse
}

export async function logout(csrfToken: string): Promise<void> {
  const response = await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  })
  if (!response.ok) {
    throw new ApiError('Não foi possível sair agora.', response.status)
  }
}
