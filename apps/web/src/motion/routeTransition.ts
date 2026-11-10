import type { DataRouter, NavigateOptions, To } from 'react-router-dom'
import { prefersReducedMotion } from './tokens'

/**
 * S25-M1: page-to-page navigation through the View Transitions API
 * (`document.startViewTransition`), a short crossfade of the page while the
 * navigation bars stay put (`styles/viewTransitions.css` names them).
 *
 * react-router already runs the transition when a navigation carries
 * `viewTransition: true` (and replays it on Back/Forward). Rather than add
 * that flag to every `<Link>`, `navigate()` and `<Navigate>` of the app, the
 * router's own `navigate` gets it by default — for the navigations that change
 * the PAGE (the pathname). Search-param and hash changes (filters, the
 * product panel) are left alone, so typing in a filter never flashes the page.
 *
 * Where the API does not exist (Firefox < 144, tests) or the user asks for
 * reduced motion, the flag is simply not set: a plain, instant navigation.
 */
type RouterNavigate = DataRouter['navigate']

export function supportsViewTransitions(): boolean {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function'
}

/** Pathname a `to` points at, or null when it stays on the page (or is relative). */
export function targetPathname(to: To | number | null): string | null {
  if (to === null || typeof to === 'number') return null
  const pathname = typeof to === 'string' ? to.split(/[?#]/)[0] : to.pathname
  return pathname !== undefined && pathname.startsWith('/') ? pathname : null
}

export function stripBasename(pathname: string, basename: string): string {
  if (basename === '/' || basename === '') return pathname
  return pathname.startsWith(basename) ? pathname.slice(basename.length) || '/' : pathname
}

export function enableRouteTransitions(router: DataRouter): void {
  const navigate = router.navigate.bind(router) as RouterNavigate
  router.navigate = ((to: To | number | null, options?: NavigateOptions) => {
    const target = targetPathname(to)
    const current = stripBasename(router.state.location.pathname, router.basename ?? '/')
    const changesPage = target !== null && target !== current
    const viewTransition = options?.viewTransition ?? (changesPage && supportsViewTransitions() && !prefersReducedMotion())
    return navigate(to as To, { ...options, viewTransition })
  }) as RouterNavigate
}
