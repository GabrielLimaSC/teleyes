import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SwapTransition, swapDirection } from './SwapTransition'
import { isSettled, springStep } from './spring'
import { staggerClass, staggerStyle } from './stagger'
import { enableRouteTransitions, stripBasename, targetPathname } from './routeTransition'
import type { DataRouter } from 'react-router-dom'
import { usePresence } from './usePresence'
import { DIALOG_PRESET, animateEnter, animateExit } from './waapi'

interface FakeAnimation {
  id: string
  frames: Keyframe[]
  options: KeyframeAnimationOptions
  finish: () => void
}

let animations: FakeAnimation[] = []
const original = Element.prototype.animate

/** jsdom has no WAAPI: a controllable stand-in whose `finished` the test resolves. */
function installFakeAnimate() {
  animations = []
  Element.prototype.animate = function (frames: Keyframe[], options: KeyframeAnimationOptions) {
    let finish = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const fake = { id: '', frames, options, finished, finish, cancel: () => {} }
    animations.push(fake)
    return fake as unknown as Animation
  } as typeof Element.prototype.animate
}

function setReducedMotion(reduced: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reduced && query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
}

beforeEach(() => installFakeAnimate())
afterEach(() => {
  Element.prototype.animate = original
  vi.restoreAllMocks()
})

describe('springStep (S25-M1)', () => {
  it('settles at rest without overshooting', () => {
    let state = { x: 100, v: 0 }
    let crossed = false
    for (let frame = 0; frame < 120; frame += 1) {
      state = springStep(state, 1 / 60, 14)
      if (state.x < 0) crossed = true
    }
    expect(crossed).toBe(false)
    expect(isSettled(state)).toBe(true)
  })

  it('is stable on a very long frame', () => {
    const state = springStep({ x: 100, v: 500 }, 5, 14)
    expect(Math.abs(state.x)).toBeLessThan(1)
  })
})

describe('waapi helpers (S25-M1)', () => {
  it('moves with transform + opacity normally', () => {
    setReducedMotion(false)
    animateEnter(document.createElement('div'), DIALOG_PRESET)
    expect(animations[0].frames).toEqual(DIALOG_PRESET.enter)
  })

  it('is only a short fade under prefers-reduced-motion', () => {
    setReducedMotion(true)
    animateEnter(document.createElement('div'), DIALOG_PRESET)
    void animateExit(document.createElement('div'), DIALOG_PRESET)
    for (const animation of animations) {
      for (const frame of animation.frames) expect(Object.keys(frame)).toEqual(['opacity'])
      expect(animation.options.duration).toBeLessThanOrEqual(120)
    }
  })

  it('resolves the exit only when the animation ends', async () => {
    setReducedMotion(false)
    let done = false
    void animateExit(document.createElement('div'), DIALOG_PRESET).then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    animations[0].finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toBe(true)
  })

  it('does not wait for an animation that cannot run', async () => {
    Element.prototype.animate = undefined as unknown as typeof Element.prototype.animate
    await expect(animateExit(document.createElement('div'), DIALOG_PRESET)).resolves.toBeUndefined()
  })
})

function Presence({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const rendered = usePresence(open, ref, (element) => animateExit(element, DIALOG_PRESET))
  return rendered ? <div ref={ref}>conteúdo</div> : null
}

describe('usePresence (S25-M1)', () => {
  it('unmounts only after the exit animation has played', async () => {
    setReducedMotion(false)
    const view = render(<Presence open />)
    expect(screen.getByText('conteúdo')).toBeInTheDocument()

    view.rerender(<Presence open={false} />)
    expect(screen.getByText('conteúdo')).toBeInTheDocument()
    expect(animations).toHaveLength(1)

    await act(async () => {
      animations[0].finish()
    })
    expect(screen.queryByText('conteúdo')).not.toBeInTheDocument()
  })

  it('unmounts at once where there is no WAAPI', () => {
    Element.prototype.animate = undefined as unknown as typeof Element.prototype.animate
    const view = render(<Presence open />)
    view.rerender(<Presence open={false} />)
    expect(screen.queryByText('conteúdo')).not.toBeInTheDocument()
  })
})

describe('SwapTransition (S25-M1)', () => {
  it('computes the direction of a tab change', () => {
    expect(swapDirection(0, 2)).toBe(1)
    expect(swapDirection(2, 1)).toBe(-1)
  })

  it('slides the new content in from the side of the chosen tab', () => {
    setReducedMotion(false)
    const view = render(
      <SwapTransition swapKey="a" direction={1}>
        <p>aba A</p>
      </SwapTransition>,
    )
    view.rerender(
      <SwapTransition swapKey="b" direction={1}>
        <p>aba B</p>
      </SwapTransition>,
    )
    const box = view.container.querySelector('.motion-swap') as HTMLElement
    expect(box.dataset.swapDirection).toBe('forward')
    // Two animations: the old copy leaves to the left, the new content enters from the right.
    const [leaving, entering] = animations
    expect(String(leaving.frames[1].transform)).toContain('-16')
    expect(String(entering.frames[0].transform)).toBe('translateX(16px)')
    expect(box.querySelectorAll('.motion-swap__ghost')).toHaveLength(1)
    expect(box.querySelector('.motion-swap__ghost')).toHaveAttribute('aria-hidden', 'true')

    view.rerender(
      <SwapTransition swapKey="a" direction={-1}>
        <p>aba A</p>
      </SwapTransition>,
    )
    expect(box.dataset.swapDirection).toBe('back')
    expect(String(animations[3].frames[0].transform)).toBe('translateX(-16px)')
  })

  it('is a plain swap under prefers-reduced-motion', () => {
    setReducedMotion(true)
    const view = render(
      <SwapTransition swapKey="a">
        <p>aba A</p>
      </SwapTransition>,
    )
    view.rerender(
      <SwapTransition swapKey="b">
        <p>aba B</p>
      </SwapTransition>,
    )
    expect(animations).toHaveLength(0)
    expect(screen.getByText('aba B')).toBeInTheDocument()
  })
})

describe('route transitions (S25-M1)', () => {
  it('only a different pathname counts as a page change', () => {
    expect(targetPathname('/regras')).toBe('/regras')
    expect(targetPathname('/regras?x=1#a')).toBe('/regras')
    expect(targetPathname({ pathname: '/fontes' })).toBe('/fontes')
    expect(targetPathname({ search: '?q=1' })).toBeNull()
    expect(targetPathname('?q=1')).toBeNull()
    expect(targetPathname(-1)).toBeNull()
  })

  it('strips the basename of the static demo', () => {
    expect(stripBasename('/teleyes/feed', '/teleyes')).toBe('/feed')
    expect(stripBasename('/teleyes', '/teleyes')).toBe('/')
    expect(stripBasename('/feed', '/')).toBe('/feed')
  })
})

describe('enableRouteTransitions (S25-M1)', () => {
  function fakeRouter() {
    const navigate = vi.fn()
    const router = { navigate, basename: '/', state: { location: { pathname: '/feed' } } }
    enableRouteTransitions(router as unknown as DataRouter)
    return { router, navigate }
  }

  beforeEach(() => {
    Object.defineProperty(document, 'startViewTransition', { value: () => {}, configurable: true })
    setReducedMotion(false)
  })
  afterEach(() => {
    Reflect.deleteProperty(document, 'startViewTransition')
  })

  it('crossfades navigations that change the page, not the ones that keep it', () => {
    const { router, navigate } = fakeRouter()
    void router.navigate('/regras')
    expect(navigate).toHaveBeenLastCalledWith('/regras', { viewTransition: true })
    void router.navigate('/feed?q=1')
    expect(navigate).toHaveBeenLastCalledWith('/feed?q=1', { viewTransition: false })
  })

  it('is an instant navigation under prefers-reduced-motion or without the API', () => {
    setReducedMotion(true)
    const reduced = fakeRouter()
    void reduced.router.navigate('/regras')
    expect(reduced.navigate).toHaveBeenLastCalledWith('/regras', { viewTransition: false })

    setReducedMotion(false)
    Reflect.deleteProperty(document, 'startViewTransition')
    const unsupported = fakeRouter()
    void unsupported.router.navigate('/regras')
    expect(unsupported.navigate).toHaveBeenLastCalledWith('/regras', { viewTransition: false })
  })
})

describe('stagger (S25-M1)', () => {
  it('only the first items of a list animate', () => {
    expect(staggerClass(0)).toBe('motion-item')
    expect(staggerClass(11)).toBe('motion-item')
    expect(staggerClass(12)).toBe('')
    expect(staggerClass(-1)).toBe('')
    expect((staggerStyle(2) as Record<string, number>)['--motion-i']).toBe(2)
  })
})
