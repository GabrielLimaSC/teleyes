import type { ReactNode } from 'react'
import { AnchoredPopover } from './AnchoredPopover'
import './HelpTip.css'

/**
 * S23-06: the small "?" next to a concept, with a one-or-two sentence plain
 * explanation. Built on AnchoredPopover (button + dialog, Esc closes and
 * returns focus).
 */
export function HelpTip({
  term,
  children,
  align = 'left',
}: {
  term: string
  children: ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <AnchoredPopover
      triggerLabel={`Ajuda: ${term}`}
      triggerContent="?"
      triggerClassName="help-tip"
      title={term}
      align={align}
    >
      <p className="help-tip__text">{children}</p>
    </AnchoredPopover>
  )
}
