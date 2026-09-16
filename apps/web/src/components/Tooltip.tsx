import { useId } from 'react'
import type { ReactNode } from 'react'
import './GlassCard.css'
import './Tooltip.css'

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const bubbleId = useId()

  return (
    <span className="tooltip" tabIndex={0} aria-describedby={bubbleId}>
      {children}
      <span className="glass-card tooltip__bubble" role="tooltip" id={bubbleId}>
        {label}
      </span>
    </span>
  )
}
