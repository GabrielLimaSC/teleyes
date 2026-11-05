import { Link } from 'react-router-dom'
import './EmptyState.css'

interface EmptyStateProps {
  title: string
  text: string
  /** Button with a handler, or a link to another screen. */
  action?: { label: string; onClick: () => void } | { label: string; to: string }
  /** Quieter second step (link style), e.g. "Ver regras". */
  secondaryAction?: { label: string; to: string }
}

/** S23-04: an empty list that teaches: what goes here, and the one next step. */
export function EmptyState({ title, text, action, secondaryAction }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <h3 className="empty-state__title">{title}</h3>
      <p className="empty-state__text">{text}</p>
      {action !== undefined &&
        ('to' in action ? (
          <Link className="plane-action empty-state__action" to={action.to}>
            {action.label}
          </Link>
        ) : (
          <button type="button" className="plane-action empty-state__action" onClick={action.onClick}>
            {action.label}
          </button>
        ))}
      {secondaryAction !== undefined && (
        <Link className="plane-action plane-action--secondary empty-state__action" to={secondaryAction.to}>
          {secondaryAction.label}
        </Link>
      )}
    </div>
  )
}
