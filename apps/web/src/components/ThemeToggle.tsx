import { useId } from 'react'
import { useTheme } from '../hooks/useTheme'
import { THEME_LABELS, nextThemePreference } from '../theme/theme'
import '../styles/materials.css'
import './ThemeToggle.css'

// S21-01: one half-filled circle for every preference. State is never carried
// by the glyph: the aria-label and the tooltip say it in words.
function Glyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 1.8 A6.2 6.2 0 0 1 8 14.2Z" fill="currentColor" />
    </svg>
  )
}

/**
 * S21-01: the 8th slot of the navbar capsule (it used to be a fixed button in
 * the viewport corner). One click cycles Sistema → Claro → Escuro. It shares
 * the tab look (`nav-tab`), but is a button, never a link, and never "active".
 */
export function ThemeToggle() {
  const { preference, cycle } = useTheme()
  const tooltipId = useId()
  const label = THEME_LABELS[preference]
  const next = THEME_LABELS[nextThemePreference(preference)]

  return (
    <div className="theme-toggle">
      <button
        type="button"
        className="nav-tab theme-toggle__button"
        aria-label={`Tema: ${label}`}
        aria-describedby={tooltipId}
        onClick={cycle}
      >
        <Glyph />
        Tema
      </button>
      <span className="plane-glass theme-toggle__tooltip" role="tooltip" id={tooltipId}>
        Tema: {label} · clique para {next}
      </span>
    </div>
  )
}
