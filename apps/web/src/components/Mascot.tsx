import { useTheme } from '../hooks/useTheme'

interface MascotProps {
  className?: string
  width?: number
  height?: number
}

/**
 * S21-01: the teleyes cat. The dark theme uses the light-lined `inverse` art,
 * the light theme the `accent` one. Decorative: its parent carries the name.
 */
export function Mascot({ className, width, height }: MascotProps) {
  const { resolved } = useTheme()
  const tone = resolved === 'dark' ? 'inverse' : 'accent'
  return (
    <img
      className={className}
      src={`${import.meta.env.BASE_URL}mascot/mascote-${tone}.png`}
      alt=""
      width={width}
      height={height}
    />
  )
}
