import { useId } from 'react'
import { useTheme } from '../hooks/useTheme'
import { THEME_LABELS, nextThemePreference } from '../theme/theme'
import type { ThemePreference } from '../theme/theme'
import '../styles/materials.css'
import './ThemeToggle.css'

// One glyph per preference, but state is never carried by the glyph alone: the
// aria-label and the tooltip both say it in words.
function Glyph({ preference }: { preference: ThemePreference }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (preference === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
      </svg>
    )
  }
  if (preference === 'dark') {
    return (
      <svg {...common}>
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16.5V20" />
    </svg>
  )
}

/**
 * S12-02: fixed glass button in the top-right corner of the viewport, outside
 * the navbar capsule. One click cycles Sistema → Claro → Escuro. The concept
 * has no theme control, so the capsule is left alone; the capsule only gets
 * narrower on small viewports to keep this button clear of it.
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
        className="plane-glass theme-toggle__button"
        aria-label={`Tema: ${label}`}
        aria-describedby={tooltipId}
        onClick={cycle}
      >
        <Glyph preference={preference} />
      </button>
      <span className="plane-glass theme-toggle__tooltip" role="tooltip" id={tooltipId}>
        Tema: {label} · clique para {next}
      </span>
    </div>
  )
}
