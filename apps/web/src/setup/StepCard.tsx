import { useId } from 'react'
import type { ReactNode } from 'react'

export type StepState = 'done' | 'current' | 'todo'

const STATE_WORD: Record<StepState, string> = {
  done: 'Concluído',
  current: 'Agora',
  todo: 'Pendente',
}

/**
 * One step of the setup wizard (S19-02). The state is always a word plus a mark,
 * never colour alone. The header is a button so the step can be reopened with the
 * keyboard; only the open step renders its body.
 */
export function StepCard({
  number,
  title,
  summary,
  state,
  open,
  onToggle,
  children,
}: {
  number: number
  title: string
  summary?: string
  state: StepState
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const bodyId = useId()
  return (
    <section className="plane-pearl setup-step" data-state={state} data-open={open}>
      <h2 className="setup-step__heading">
        <button
          type="button"
          className="setup-step__header"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="setup-step__mark" aria-hidden="true">
            {state === 'done' ? '✓' : number}
          </span>
          <span className="setup-step__titles">
            <span className="setup-step__title">{title}</span>
            {summary !== undefined && <span className="setup-step__summary">{summary}</span>}
          </span>
          <span className="setup-step__state">{STATE_WORD[state]}</span>
        </button>
      </h2>
      {open && (
        <div id={bodyId} className="setup-step__body">
          {children}
        </div>
      )}
    </section>
  )
}
