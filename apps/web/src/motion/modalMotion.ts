import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'
import { BACKDROP_PRESET, animateEnter, animateExit } from './waapi'
import type { MotionPreset } from './waapi'
import { supportsWaapi } from './tokens'

/**
 * S25-M1: motion for a modal that its CALLER mounts and unmounts
 * (`{target && <ConfirmDialog …/>}`), so the component cannot hold itself on
 * screen. The entrance plays in a layout effect (no unanimated first frame).
 * When the component unmounts, the DOM it had is cloned, inert, to where it
 * was, and the clone plays the exit and removes itself — to the user the
 * dialog simply animates out, whichever button (or the parent) closed it.
 *
 * `backdropRef` fades; `panelRef` takes the `panelPreset`. `active` is for
 * modals that stay mounted and render nothing while closed.
 */
export function useModalMotion(
  backdropRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  panelPreset: MotionPreset,
  active = true,
): void {
  useLayoutEffect(() => {
    if (!active) return
    const backdrop = backdropRef.current
    const panel = panelRef.current
    if (backdrop === null || panel === null || !supportsWaapi()) return
    animateEnter(backdrop, BACKDROP_PRESET)
    animateEnter(panel, panelPreset)
    const panelPath = pathBetween(backdrop, panel)

    return () => {
      const parent = backdrop.parentNode
      const ghost = backdrop.cloneNode(true) as HTMLElement
      // StrictMode's simulated unmount keeps the node connected: no ghost then.
      queueMicrotask(() => {
        if (backdrop.isConnected || parent === null || !parent.isConnected) return
        runGhost(ghost, parent, panelPath, panelPreset)
      })
    }
  }, [backdropRef, panelRef, panelPreset, active])
}

function runGhost(ghost: HTMLElement, parent: ParentNode, panelPath: number[], panelPreset: MotionPreset): void {
  // The copy must not be a second dialog: no ids, roles, marker attributes,
  // focus, clicks or screen-reader presence.
  ghost.removeAttribute('id')
  ghost.removeAttribute('data-confirm-dialog')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.setAttribute('inert', '')
  ghost.style.pointerEvents = 'none'
  for (const node of ghost.querySelectorAll<HTMLElement>('[id], [role], [data-confirm-dialog]')) {
    node.removeAttribute('id')
    node.removeAttribute('role')
    node.removeAttribute('data-confirm-dialog')
  }
  parent.appendChild(ghost)

  const panel = panelPath.reduce<Element | null>((node, index) => node?.children[index] ?? null, ghost)
  const done = [animateExit(ghost, BACKDROP_PRESET)]
  if (panel instanceof HTMLElement) done.push(animateExit(panel, panelPreset))
  void Promise.all(done).then(() => ghost.remove())
}

/** Child indices that lead from `root` down to `target`. */
function pathBetween(root: HTMLElement, target: HTMLElement): number[] {
  const path: number[] = []
  for (let node: HTMLElement | null = target; node !== null && node !== root; node = node.parentElement) {
    const parent: HTMLElement | null = node.parentElement
    if (parent === null) break
    path.unshift(Array.prototype.indexOf.call(parent.children, node))
  }
  return path
}
