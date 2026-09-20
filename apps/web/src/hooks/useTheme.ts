import { useCallback, useSyncExternalStore } from 'react'
import { getThemeState, nextThemePreference, setThemePreference, subscribeTheme } from '../theme/theme'
import type { ResolvedTheme, ThemePreference } from '../theme/theme'

interface UseThemeResult {
  /** What the user chose: system | light | dark. */
  preference: ThemePreference
  /** What is actually applied (system resolved through prefers-color-scheme). */
  resolved: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
  /** system → light → dark → system. */
  cycle: () => void
}

export function useTheme(): UseThemeResult {
  const { preference, resolved } = useSyncExternalStore(subscribeTheme, getThemeState, getThemeState)
  const cycle = useCallback(() => setThemePreference(nextThemePreference(getThemeState().preference)), [])
  return { preference, resolved, setPreference: setThemePreference, cycle }
}
