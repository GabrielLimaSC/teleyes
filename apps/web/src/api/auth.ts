export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface LoginResponse {
  csrf_token: string
}

export interface MeResponse {
  admin_id: number
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
