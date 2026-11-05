import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { BottomSheet } from '../components/BottomSheet'
import type { Rule, Snooze } from '../api/types'
import './FeedMobileTop.css'

const SCROLLED_AWAY_PX = 240
const AT_TOP_PX = 80

/** S24-02b: counts offers that arrived over the live feed while the user was
 * scrolled away from the top; resets once they are back at the top. */
function useNewOffersCount(matchIds: number[], loading: boolean): [number, () => void] {
  const [count, setCount] = useState(0)
  const seenRef = useRef<Set<number> | null>(null)

  const heightRef = useRef(0)
  // Keep the reading position: when offers are inserted above while scrolled,
  // grow-compensate the scroll offset by the document height delta.
  useLayoutEffect(() => {
    const height = document.documentElement.scrollHeight
    const delta = height - heightRef.current
    const prev = seenRef.current
    const grew = prev !== null && matchIds.some((id) => !prev.has(id))
    if (grew && window.scrollY > 0 && delta > 0 && heightRef.current > 0) window.scrollBy(0, delta)
    heightRef.current = height
  }, [matchIds])

  useEffect(() => {
    if (loading) return
    const seen = seenRef.current
    seenRef.current = new Set(matchIds)
    if (seen === null) return
    const added = matchIds.filter((id) => !seen.has(id)).length
    if (added > 0 && window.scrollY > SCROLLED_AWAY_PX) setCount((current) => current + added)
  }, [matchIds, loading])

  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY <= AT_TOP_PX) setCount(0)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const goTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
    setCount(0)
  }
  return [count, goTop]
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

      {newCount > 0 && (
        <button type="button" className="feed-mobile-top__pill" onClick={goTop}>
          <span aria-hidden="true">↑ </span>
          {newCount === 1 ? '1 oferta nova' : `${newCount} ofertas novas`}
        </button>
      )}

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
