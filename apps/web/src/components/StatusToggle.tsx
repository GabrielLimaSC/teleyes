import './StatusToggle.css'

/**
 * Two-way on/off switch for an entity's `active` flag. Rules pass `onResume`
 * (S18-01) and the switch works in both directions; sources and recipients
 * have no resume endpoint yet, so without `onResume` a paused entity stays
 * disabled with the explanatory title it always had.
 */
export function StatusToggle({
  active,
  onPause,
  onResume,
  pausing,
}: {
  active: boolean
  onPause: () => void
  onResume?: () => void
  pausing: boolean
}) {
  const canToggle = active || onResume !== undefined
  const title = active
    ? 'Pausar'
    : onResume !== undefined
      ? 'Reativar'
      : 'Reativação ainda não é possível pela API — exclua e recrie se precisar reativar.'
  return (
    <button
      type="button"
      role="switch"
      className={`status-toggle ${active ? 'status-toggle--active' : 'status-toggle--paused'}`}
      onClick={active ? onPause : onResume}
      disabled={!canToggle || pausing}
      aria-checked={active}
      aria-busy={pausing}
      title={title}
    >
      <span className="status-toggle__knob" />
      <span className="status-toggle__label">{active ? 'ativa' : 'pausada'}</span>
    </button>
  )
}
