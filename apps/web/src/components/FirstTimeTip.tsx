import { useState } from 'react'
import type { ReactNode } from 'react'
import { readFlag, tipKey, writeFlag } from '../onboarding/storage'
import './EmptyState.css'

/**
 * S23-04: one discreet, closable line per screen that says what the screen is
 * for. Once closed it never comes back on this browser.
 */
export function FirstTimeTip({ id, children }: { id: string; children: ReactNode }) {
  const [closed, setClosed] = useState(() => readFlag(tipKey(id)) !== null)
  if (closed) return null
  return (
    <aside className="first-tip" aria-label="Dica">
      <p className="first-tip__text">{children}</p>
      <button
        type="button"
        className="first-tip__close"
        onClick={() => {
          writeFlag(tipKey(id), 'closed')
          setClosed(true)
        }}
      >
        Entendi
      </button>
    </aside>
  )
}
