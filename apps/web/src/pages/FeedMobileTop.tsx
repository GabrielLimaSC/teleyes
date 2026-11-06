import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNewOffersCount } from './useNewOffersCount'
import type { ReactNode } from 'react'
import { BottomSheet } from '../components/BottomSheet'
import { prefersReducedMotion } from '../chrome/scrollChrome'
import { CHROME_SPRING_EASING, animateEnter, animateExit, usePresence } from '../motion'
import type { MotionPreset } from '../motion'
import type { Rule, Snooze } from '../api/types'
import './FeedMobileTop.css'

const PILL_PRESET: MotionPreset = {
  enter: [
    { opacity: 0, transform: 'translateY(-14px) scale(0.92)' },
    { opacity: 1, transform: 'translateY(0) scale(1)' },
  ],
  exit: [
    { opacity: 1, transform: 'translateY(0) scale(1)' },
    { opacity: 0, transform: 'translateY(-10px) scale(0.96)' },
  ],
  enterMs: 380,
  exitMs: 160,
}

/** S25-F2: the "↑ N ofertas novas" pill, shared by the phone (fixed under the
 * app bar) and the desktop (B1: sticky at the top of the cards column). It
 * springs in and out; `className` positions it. */
export function NewOffersPill({ count, onClick, className }: { count: number; onClick: () => void; className: string }) {
  const ref = useRef<HTMLButtonElement>(null)
  // Keeps the last number while the pill is leaving (count is already 0).
  const [lastCount, setLastCount] = useState(count)
  if (count > 0 && count !== lastCount) setLastCount(count)
  const open = count > 0
  const rendered = usePresence(open, ref, (element) => animateExit(element, PILL_PRESET))
  useLayoutEffect(() => {
    if (open && ref.current) animateEnter(ref.current, PILL_PRESET)
  }, [open])
  if (!rendered) return null
  const shown = lastCount
  return (
    <button ref={ref} type="button" className={className} onClick={onClick} inert={!open}>
      <span aria-hidden="true">↑ </span>
      {shown === 1 ? '1 oferta nova' : `${shown} ofertas novas`}
    </button>
  )
}

const PULL_THRESHOLD = 64
const PULL_MAX = 110
const REFRESH_HOLD_MS = 900

type PullPhase = 'idle' | 'pulling' | 'ready' | 'loading'

/** S25-F2 (screen 32): pull the list down at the very top to refresh. The
 * finger drives the indicator directly (no React state per frame); release
 * springs it back, or holds it while "Atualizando…" shows. */
function usePullToRefresh(onRefresh: () => void) {
  const indicatorRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<PullPhase>('idle')
  const refreshRef = useRef(onRefresh)
  useEffect(() => {
    refreshRef.current = onRefresh
  })

  useEffect(() => {
    const indicator = indicatorRef.current
    if (indicator === null) return
    let startY = 0
    let tracking = false
    let pull = 0
    let current: PullPhase = 'idle'
    let holdTimer = 0

    const setCurrent = (next: PullPhase) => {
      if (next === current) return
      current = next
      setPhase(next)
    }
    const frame = (distance: number): Keyframe => ({
      transform: `translateY(${distance - 52}px)`,
      opacity: Math.min(distance / PULL_THRESHOLD, 1),
    })
    const paint = (distance: number) => {
      const { transform, opacity } = frame(distance)
      indicator.style.transform = String(transform)
      indicator.style.opacity = String(opacity)
      indicator.style.setProperty('--pull-progress', String(Math.min(distance / PULL_THRESHOLD, 1)))
    }
    const settle = (to: number) => {
      const from = pull
      pull = to
      if (!prefersReducedMotion() && typeof indicator.animate === 'function') {
        indicator.animate([frame(from), frame(to)], { duration: 460, easing: CHROME_SPRING_EASING })
      }
      paint(to)
    }

    const onStart = (event: TouchEvent) => {
      if (current === 'loading' || event.touches.length !== 1 || window.scrollY > 0) return
      if (event.target instanceof Element && event.target.closest('[role="dialog"], input, textarea')) return
      startY = event.touches[0].clientY
      tracking = true
    }
    const onMove = (event: TouchEvent) => {
      if (!tracking) return
      const delta = event.touches[0].clientY - startY
      if (delta <= 0 || window.scrollY > 0) {
        if (pull > 0) {
          pull = 0
          paint(0)
          setCurrent('idle')
        }
        return
      }
      // Rubber band: the further, the heavier.
      pull = Math.min(PULL_MAX, delta * 0.5)
      if (event.cancelable) event.preventDefault()
      paint(pull)
      setCurrent(pull >= PULL_THRESHOLD ? 'ready' : 'pulling')
    }
    const onEnd = () => {
      if (!tracking) return
      tracking = false
      if (current === 'ready') {
        setCurrent('loading')
        settle(PULL_THRESHOLD)
        refreshRef.current()
        holdTimer = window.setTimeout(() => {
          settle(0)
          setCurrent('idle')
        }, REFRESH_HOLD_MS)
      } else if (pull > 0) {
        settle(0)
        setCurrent('idle')
      }
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onEnd)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
      window.clearTimeout(holdTimer)
    }
  }, [])

  return { indicatorRef, phase }
}

const PULL_LABEL: Record<PullPhase, string> = {
  idle: '',
  pulling: 'Puxe para atualizar',
  ready: 'Solte para atualizar',
  loading: 'Atualizando…',
}

export interface FeedMobileTopProps {
  rules: Rule[]
  ruleCounts: Map<number, number>
  totalCount: number
  matchIds: number[]
  loading: boolean
  selectedRuleId: number | null
  onSelectRule: (ruleId: number | null) => void
  snoozes: Snooze[]
  snoozeRemaining: (snooze: Snooze) => string
  onReactivate: (snoozeId: number) => void
  /** `null` while the setting has not loaded (the toggle is hidden). */
  groupDuplicates: boolean | null
  onToggleGroupDuplicates: () => void
  onRefresh: () => void
  targets: ReactNode
  targetsCount: number
  sourcesList: ReactNode
  sourcesCount: number
}

/** S24-02b (screens 03 and 05): phone-only list top — filter line, silenced
 * count, "N ofertas novas" pill and the "Filtrar por regra" sheet. */
export function FeedMobileTop(props: FeedMobileTopProps) {
  const { rules, ruleCounts, totalCount, selectedRuleId, snoozes } = props
  const [open, setOpen] = useState(false)
  const [newCount, goTop] = useNewOffersCount(props.matchIds, props.loading)
  const { indicatorRef, phase } = usePullToRefresh(props.onRefresh)

  const sortedRules = [...rules].sort((a, b) => (ruleCounts.get(b.id) ?? 0) - (ruleCounts.get(a.id) ?? 0))
  const selected = rules.find((rule) => rule.id === selectedRuleId)
  const label = selected ? selected.name : 'Todas as regras'
  const labelCount = selected ? (ruleCounts.get(selected.id) ?? 0) : totalCount

  const choose = (ruleId: number | null) => {
    props.onSelectRule(ruleId)
    setOpen(false)
  }

  return (
    <>
      <div className="feed-mobile-top">
        <button type="button" className="feed-mobile-top__filter" onClick={() => setOpen(true)} aria-haspopup="dialog">
          <span className="feed-mobile-top__filter-label">{label}</span>
          <span className="feed-mobile-top__count">· {labelCount}</span>
          <span aria-hidden="true"> ▾</span>
        </button>
        {snoozes.length > 0 && (
          <button type="button" className="feed-mobile-top__muted" onClick={() => setOpen(true)}>
            Silenciados · {snoozes.length}
          </button>
        )}
      </div>

      <NewOffersPill count={newCount} onClick={goTop} className="feed-mobile-top__pill" />

      <div ref={indicatorRef} className="feed-pull" data-phase={phase} role="status" aria-live="polite">
        <span className="feed-pull__bubble">
          <span className="feed-pull__arrow" aria-hidden="true">
            ↻
          </span>
          <span className="feed-pull__label">{PULL_LABEL[phase]}</span>
        </span>
      </div>

      <BottomSheet open={open} onClose={() => setOpen(false)} title="Filtrar por regra">
        <div className="feed-mobile-sheet">
          <ul className="feed-mobile-sheet__list">
            <li>
              <button
                type="button"
                className={`feed-mobile-sheet__rule${selectedRuleId === null ? ' feed-mobile-sheet__rule--active' : ''}`}
                aria-pressed={selectedRuleId === null}
                onClick={() => choose(null)}
              >
                <span>Todas as regras</span>
                <span>{totalCount}</span>
              </button>
            </li>
            {sortedRules.map((rule) => (
              <li key={rule.id}>
                <button
                  type="button"
                  className={`feed-mobile-sheet__rule${selectedRuleId === rule.id ? ' feed-mobile-sheet__rule--active' : ''}`}
                  aria-pressed={selectedRuleId === rule.id}
                  onClick={() => choose(rule.id)}
                >
                  <span>{rule.name}</span>
                  <span>{ruleCounts.get(rule.id) ?? 0}</span>
                </button>
              </li>
            ))}
          </ul>

          {snoozes.length > 0 && (
            <section aria-label="Silenciados">
              <div className="feed-mobile-sheet__eyebrow">Silenciados</div>
              <ul className="feed-mobile-sheet__list">
                {snoozes.map((snooze) => (
                  <li key={snooze.id} className="feed-mobile-sheet__snooze">
                    <div>
                      <div className="feed-mobile-sheet__snooze-label">{snooze.label}</div>
                      <div className="feed-mobile-sheet__snooze-meta">
                        {snooze.scope === 'rule' ? 'regra' : 'produto'} · {props.snoozeRemaining(snooze)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="plane-action plane-action--secondary feed-mobile-sheet__reactivate"
                      onClick={() => props.onReactivate(snooze.id)}
                    >
                      Reativar
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <details className="feed-mobile-sheet__fold">
            <summary>Preços-alvo · {props.targetsCount}</summary>
            {props.targets}
          </details>
          <details className="feed-mobile-sheet__fold">
            <summary>Grupos · {props.sourcesCount}</summary>
            {props.sourcesList}
          </details>

          <div className="feed-mobile-sheet__controls">
            {props.groupDuplicates !== null && (
              <button
                type="button"
                className="feed-mobile-sheet__switch"
                role="switch"
                aria-checked={props.groupDuplicates}
                onClick={props.onToggleGroupDuplicates}
              >
                Agrupar duplicatas
                <span
                  className={props.groupDuplicates ? 'feed-toggle-switch feed-toggle-switch--on' : 'feed-toggle-switch'}
                  aria-hidden="true"
                >
                  <span className="feed-toggle-switch__knob" />
                </span>
              </button>
            )}
            <button
              type="button"
              className="plane-action plane-action--secondary feed-mobile-sheet__refresh"
              onClick={() => {
                props.onRefresh()
                setOpen(false)
              }}
            >
              <span aria-hidden="true">↻</span> Atualizar
            </button>
          </div>
        </div>
      </BottomSheet>
    </>
  )
}
