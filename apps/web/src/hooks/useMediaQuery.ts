import { useEffect, useState } from 'react'

/** Reactive `window.matchMedia(query).matches`, kept in sync as the
 * viewport/preference changes. SSR-free app (Vite SPA), so `window` always
 * exists by the time a component renders. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = () => setMatches(list.matches)
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** S14-08 (07b): below this width the product panel becomes a full-screen
 * sheet instead of a 520px side column. */
export const PRODUCT_PANEL_SHEET_QUERY = '(max-width: 959px)'

/** S20-01: from 960px up to 1099px a 520px side column would leave the page
 * content a sliver, so the panel is a fixed drawer over the content (with a
 * backdrop) instead of a grid column. */
export const PRODUCT_PANEL_DRAWER_QUERY = '(min-width: 960px) and (max-width: 1099px)'

export const useIsProductPanelDrawer = (): boolean => useMediaQuery(PRODUCT_PANEL_DRAWER_QUERY)

export const useIsProductPanelSheet = (): boolean => useMediaQuery(PRODUCT_PANEL_SHEET_QUERY)

export const usePrefersReducedMotion = (): boolean => useMediaQuery('(prefers-reduced-motion: reduce)')
