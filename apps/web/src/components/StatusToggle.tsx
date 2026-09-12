import './StatusToggle.css'

export function StatusToggle({
  active,
  onPause,
  pausing,
}: {
  active: boolean
  onPause: () => void
  pausing: boolean
}) {
  return (
    <button
      type="button"
      className={`status-toggle ${active ? 'status-toggle--active' : 'status-toggle--paused'}`}
      onClick={active ? onPause : undefined}
      disabled={!active || pausing}
      aria-pressed={active}
      title={
        active
          ? 'Pausar'
          : 'Reativação ainda não é possível pela API — exclua e recrie se precisar reativar.'
      }
    >
      <span className="status-toggle__knob" />
      <span className="status-toggle__label">{active ? 'ativa' : 'pausada'}</span>
    </button>
  )
}
