import type { Page } from '@playwright/test'

export const E2E_PASSWORD = 'e2e-test-password'

// `page.request` has its own cookie jar that doesn't apply the browser's
// "localhost counts as a secure context" rule the same way page fetches do,
// so a Secure session cookie set through it never sticks. Driving this
// through page.evaluate() runs it as a real in-page fetch — same as the app
// itself — so the session cookie behaves exactly like it does for a user.
export async function apiLogin(page: Page): Promise<string> {
  return page.evaluate(async (password) => {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password }),
    })
    const body = (await response.json()) as { csrf_token: string }
    // Mirror what AuthContext.login() does — pages that read csrfToken from
    // useAuth() (Regras/Fontes/etc.) need it in sessionStorage, not just
    // returned here, or their mutations silently no-op on a null token.
    sessionStorage.setItem('teleyes.csrf_token', body.csrf_token)
    return body.csrf_token
  }, E2E_PASSWORD)
}

export async function apiPost<T>(page: Page, path: string, csrfToken: string, data: unknown): Promise<T> {
  return page.evaluate(
    async ({ path, csrfToken, data }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify(data),
      })
      return (await response.json()) as unknown
    },
    { path, csrfToken, data },
  ) as Promise<T>
}
