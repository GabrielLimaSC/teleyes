import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { listRecipients } from '../api/recipients'
import { listRules } from '../api/rules'
import { listSources } from '../api/sources'
import type { SetupStatus } from '../api/setup'
import { useSetupStatus } from '../hooks/useSetupStatus'
import { FIRST_RUN_KEY, readFlag, writeFlag } from '../onboarding/storage'
import './FirstRunCard.css'

interface Counts {
  sources: number
  authorizedRecipients: number
  rules: number
}

export interface FirstRunStep {
  id: 'telegram' | 'bot' | 'rule'
  title: string
  doneText: string
  todoText: string
  cta: string
  to: string
  done: boolean
}

/** Pure: the three essential steps, from what the existing endpoints say. */
export function buildFirstRunSteps(setup: SetupStatus | null, counts: Counts): FirstRunStep[] {
  const telegramDone = (setup?.steps.credentials === true && setup.steps.login) || counts.sources > 0
  return [
    {
      id: 'telegram',
      title: 'Conectar o Telegram',
      doneText:
        counts.sources > 0
          ? `Telegram conectado, ${counts.sources} ${counts.sources === 1 ? 'grupo' : 'grupos'} em monitoramento.`
          : 'Conta do Telegram conectada.',
      todoText: 'Entre com a conta do Telegram que já está nos grupos de promoção.',
      cta: 'Conectar o Telegram',
      to: '/configuracao',
      done: telegramDone,
    },
    {
      id: 'bot',
      title: 'Conectar o bot e um destinatário',
      doneText: `${counts.authorizedRecipients} ${counts.authorizedRecipients === 1 ? 'destinatário autorizado' : 'destinatários autorizados'} para receber alertas.`,
      todoText: 'O bot manda os alertas no Telegram para quem você autorizar.',
      cta: 'Conectar o bot',
      to: '/configuracao',
      done: counts.authorizedRecipients > 0,
    },
    {
      id: 'rule',
      title: 'Criar a primeira regra',
      doneText: `${counts.rules} ${counts.rules === 1 ? 'regra criada' : 'regras criadas'}.`,
      todoText: 'Diga o que procurar e até quanto vale pagar.',
      cta: 'Criar a primeira regra',
      to: '/regras?nova=1',
      done: counts.rules > 0,
    },
  ]
}

/** Lives for the page (reload resets it): "Tudo pronto" is shown for one session. */
let celebrating = false
export function resetFirstRunSession(): void {
  celebrating = false
}

/**
 * S23-04: "Comece por aqui" on Início. Three steps, driven by the endpoints the
 * panel already uses; shows nothing when the setup API is unavailable (demo) or
 * the person dismissed it.
 */
export function FirstRunCard({ onVisibleChange }: { onVisibleChange?: (visible: boolean) => void } = {}) {
  const { status: setup, unavailable, loading: setupLoading, refresh } = useSetupStatus()
  const [counts, setCounts] = useState<Counts | null>(null)
  const [dismissed, setDismissed] = useState(() => readFlag(FIRST_RUN_KEY) === 'dismissed')
  const [celebrate, setCelebrate] = useState(celebrating)
  const [announcement, setAnnouncement] = useState('')
  const previous = useRef<Record<string, boolean> | null>(null)

  const loadCounts = useCallback(() => {
    Promise.all([listRules(), listSources(), listRecipients()])
      .then(([rules, sources, recipients]) =>
        setCounts({
          rules: rules.length,
          sources: sources.length,
          authorizedRecipients: recipients.filter((recipient) => recipient.allowlisted && recipient.active).length,
        }),
      )
      .catch(() => {
        /* without real numbers the card stays out of the way */
      })
  }, [])

  useEffect(loadCounts, [loadCounts])

  // Coming back from another tab/window (e.g. after pairing the bot): re-read.
  useEffect(() => {
    const onFocus = () => {
      refresh()
      loadCounts()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh, loadCounts])

  const steps = counts === null ? null : buildFirstRunSteps(setup, counts)
  const doneCount = steps === null ? 0 : steps.filter((step) => step.done).length
  const allDone = steps !== null && doneCount === steps.length

  // Announce only when a step changes after the first reading, never on load.
  useEffect(() => {
    if (steps === null) return
    const now = Object.fromEntries(steps.map((step) => [step.id, step.done]))
    const before = previous.current
    previous.current = now
    if (before === null) return
    const finished = steps.find((step) => step.done && !before[step.id])
    if (finished !== undefined) setAnnouncement(`Passo concluído: ${finished.title}.`)
  }, [steps])

  // Persist the lifecycle: incomplete -> pending; complete after pending -> celebrate once.
  useEffect(() => {
    if (steps === null || setupLoading || dismissed) return
    if (!allDone) {
      writeFlag(FIRST_RUN_KEY, 'pending')
      return
    }
    if (readFlag(FIRST_RUN_KEY) === 'pending') {
      celebrating = true
      setCelebrate(true)
    }
    writeFlag(FIRST_RUN_KEY, 'dismissed')
  }, [steps, allDone, setupLoading, dismissed])

  const hidden = unavailable !== null || setupLoading || steps === null || (allDone && !celebrate) || dismissed
  // S25-F1a: Início swaps this card for "Últimas ofertas" once it is gone.
  const settled = unavailable !== null || (!setupLoading && steps !== null)
  useEffect(() => {
    if (settled) onVisibleChange?.(!hidden)
  }, [settled, hidden, onVisibleChange])
  if (hidden) return null

  const dismiss = () => {
    celebrating = false
    setCelebrate(false)
    writeFlag(FIRST_RUN_KEY, 'dismissed')
    setDismissed(true)
  }
  const nextId = steps.find((step) => !step.done)?.id

  return (
    <section className="plane-pearl first-run" aria-labelledby="first-run-title">
      <div className="first-run__head">
        <div>
          <h2 id="first-run-title">
            {allDone ? 'Tudo pronto' : `Primeiros passos · ${doneCount} de ${steps.length}`}
          </h2>
          <p className="first-run__lede">
            {allDone
              ? 'O teleyes já lê seus grupos e avisa quando uma promoção bate numa regra.'
              : 'Três passos e o teleyes começa a avisar você das promoções que valem a pena.'}
          </p>
        </div>
        <button type="button" className="first-run__skip" onClick={dismiss}>
          {allDone ? 'Fechar' : 'Ocultar'}
        </button>
      </div>
      <div
        className="first-run__progress"
        role="progressbar"
        aria-label="Progresso da configuração"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={doneCount}
        aria-valuetext={`${doneCount} de ${steps.length} passos`}
      >
        <span className="first-run__progress-fill" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>
      <p className="first-run__count">
        {doneCount} de {steps.length} passos
      </p>
      <ol className="first-run__steps">
        {steps.map((step, index) => (
          <li key={step.id} className="first-run__step" data-done={step.done || undefined} data-testid={`first-run-${step.id}`}>
            <span className="first-run__mark" aria-hidden="true">
              {step.done ? '✓' : index + 1}
            </span>
            <div className="first-run__body">
              <p className="first-run__title">
                {step.title}
                {step.done && <span className="sr-only"> (concluído)</span>}
              </p>
              <p className="first-run__text">{step.done ? step.doneText : step.todoText}</p>
            </div>
            {!step.done && (
              <Link
                className={`plane-action first-run__cta${step.id === nextId ? '' : ' plane-action--secondary'}`}
                to={step.to}
              >
                {step.cta}
              </Link>
            )}
          </li>
        ))}
      </ol>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </section>
  )
}
