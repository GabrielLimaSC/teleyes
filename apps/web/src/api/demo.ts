import { ApiError } from './auth'

/** S19-03: what the API answers (403) to every write while `TELEYES_DEMO_READONLY=1`. */
export const DEMO_READONLY_MESSAGE = 'Modo demonstração: alterações desativadas.'
export const DEMO_BANNER_TEXT = 'Modo demonstração — dados fictícios'
/** Public on purpose: it only exists next to fictional data (see apps/api/app/demo_mode.py). */
export const DEMO_PASSWORD = 'demo-teleyes'

const DEMO_READONLY_EVENT = 'teleyes:demo-readonly'

export function isDemoReadOnly(status: number, detail: string): boolean {
  return status === 403 && detail === DEMO_READONLY_MESSAGE
}

/** Called by `apiRequest`; the app-level `DemoBanner` turns it into a toast, so
 * every page degrades the same way without knowing about demo mode. */
export function notifyDemoReadOnly(): void {
  window.dispatchEvent(new CustomEvent(DEMO_READONLY_EVENT))
}

export function onDemoReadOnly(listener: () => void): () => void {
  window.addEventListener(DEMO_READONLY_EVENT, listener)
  return () => window.removeEventListener(DEMO_READONLY_EVENT, listener)
}

/** Reports a failed write inline, except when the read-only demo refused it: that
 * already has its toast, and an inline error on these pages replaces the whole
 * list, so the refusal must not hide the data the visitor is looking at. */
export function reportFailure(error: unknown, message: string, report: (message: string) => void): void {
  if (error instanceof ApiError && isDemoReadOnly(error.status, error.message)) return
  report(message)
}
