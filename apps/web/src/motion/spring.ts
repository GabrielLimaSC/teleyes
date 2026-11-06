/**
 * S25-M1: a critically damped spring, in closed form (so a long frame or a
 * background tab can never make it blow up, unlike explicit Euler).
 *
 * `x` is the displacement from the rest position (target 0) and `v` its
 * velocity in px/s. `omega` is the stiffness: the spring settles to within 2%
 * in about `5.8 / omega` seconds (omega 14 → ~415 ms). No overshoot.
 */
export interface SpringState {
  x: number
  v: number
}

export function springStep({ x, v }: SpringState, dt: number, omega: number): SpringState {
  const decay = Math.exp(-omega * dt)
  const b = v + omega * x
  return {
    x: (x + b * dt) * decay,
    v: (v - omega * b * dt) * decay,
  }
}

export function isSettled({ x, v }: SpringState, epsilon = 0.1): boolean {
  return Math.abs(x) < epsilon && Math.abs(v) < epsilon * 10
}
