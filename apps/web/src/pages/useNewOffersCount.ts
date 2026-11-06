import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../chrome/scrollChrome'

const SCROLLED_AWAY_PX = 240
const AT_TOP_PX = 80

/** S24-02b: counts offers that arrived over the live feed while the user was
 * scrolled away from the top; resets once they are back at the top. */
export function useNewOffersCount(matchIds: number[], loading: boolean): [number, () => void] {
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
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    setCount(0)
  }
  return [count, goTop]
}
