import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { PricePoint } from '../api/types'
import './RuleHistoryChart.css'

const PAD_PCT = 10

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/** `PricePoint.date` is already `YYYY-MM-DD` in the display timezone: a plain
 * string split, never a `Date` (same rule as ProductPanel). */
function formatDay(day: string): string {
  const [, month, dayOfMonth] = day.split('-')
  return `${dayOfMonth}/${month}`
}

/**
 * S21-02: the 30-day chart of a rule, shown in its expanded row. Same data as
 * the old sparkline (`rule.history_30d`, lowest price per day) but large, with
 * dashed lines for the ceiling ("teto") and the target ("alvo") when the rule
 * has them, and a tooltip per day (hover, or Left/Right arrows when focused).
 * Geometry is a 0-100 box stretched over the plot, so the dots and the tooltip
 * (plain HTML) line up with the SVG lines by percentage.
 */
export function RuleHistoryChart({
  points,
  ceilingCents,
  targetCents,
}: {
  points: PricePoint[]
  ceilingCents: number | null
  targetCents: number | null
}) {
  const tooltipId = useId()
  const [active, setActive] = useState<number | null>(null)

  if (points.length === 0) {
    return <p className="rule-chart__empty">Sem preços nos últimos 30 dias.</p>
  }

  const values = points.map((point) => point.price_cents)
  const domain = [
    ...values,
    ...(ceilingCents !== null ? [ceilingCents] : []),
    ...(targetCents !== null ? [targetCents] : []),
  ]
  const min = Math.min(...domain)
  const max = Math.max(...domain)
  const span = Math.max(max - min, 1)
  const yOf = (cents: number) => PAD_PCT + (1 - (cents - min) / span) * (100 - PAD_PCT * 2)
  const xOf = (index: number) => (points.length === 1 ? 50 : (index / (points.length - 1)) * 100)

  // One real day is still a real price: drawn flat across the plot.
  const line = (points.length === 1 ? [points[0], points[0]] : points)
    .map((point, index, all) => `${(index / (all.length - 1)) * 100},${yOf(point.price_cents)}`)
    .join(' ')

  const current = active === null ? null : points[active]
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setActive((index) => Math.max((index ?? points.length) - 1, 0))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setActive((index) => Math.min((index ?? -1) + 1, points.length - 1))
    } else if (event.key === 'Escape' && active !== null) {
      event.stopPropagation()
      setActive(null)
    }
  }

  return (
    <figure className="rule-chart">
      <figcaption className="rule-chart__legend">
        <span>Menor preço por dia · {points.length === 1 ? '1 dia' : `${points.length} dias`}</span>
        {ceilingCents !== null && (
          <span className="rule-chart__key rule-chart__key--ceiling">teto {formatBrl(ceilingCents)}</span>
        )}
        {targetCents !== null && (
          <span className="rule-chart__key rule-chart__key--target">alvo {formatBrl(targetCents)}</span>
        )}
      </figcaption>
      <div
        className="rule-chart__plot"
        role="group"
        tabIndex={0}
        aria-label={`Histórico real de ${points.length} ${points.length === 1 ? 'dia' : 'dias'}: menor ${formatBrl(Math.min(...values))}, maior ${formatBrl(Math.max(...values))}, último ${formatBrl(values[values.length - 1])}. Use as setas para ler cada dia.`}
        aria-describedby={tooltipId}
        onKeyDown={move}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
      >
        <svg className="rule-chart__svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {ceilingCents !== null && (
            <line
              className="rule-chart__ref rule-chart__ref--ceiling"
              x1="0"
              x2="100"
              y1={yOf(ceilingCents)}
              y2={yOf(ceilingCents)}
            />
          )}
          {targetCents !== null && (
            <line
              className="rule-chart__ref rule-chart__ref--target"
              x1="0"
              x2="100"
              y1={yOf(targetCents)}
              y2={yOf(targetCents)}
            />
          )}
          <polyline className="rule-chart__line" points={line} />
        </svg>
        {points.map((point, index) => (
          <span
            key={point.date}
            className={`rule-chart__dot${index === active ? ' rule-chart__dot--active' : ''}`}
            style={{ left: `${xOf(index)}%`, top: `${yOf(point.price_cents)}%` }}
            aria-hidden="true"
          />
        ))}
        <div className="rule-chart__hits" aria-hidden="true">
          {points.map((point, index) => (
            <span
              key={point.date}
              className="rule-chart__hit"
              data-day={point.date}
              onMouseEnter={() => setActive(index)}
            />
          ))}
        </div>
        {current !== null && active !== null && (
          <span
            className="rule-chart__tooltip"
            data-testid="rule-chart-tooltip"
            style={{ left: `${xOf(active)}%`, top: `${yOf(current.price_cents)}%` }}
          >
            <strong>{formatBrl(current.price_cents)}</strong>
            <span>{formatDay(current.date)}</span>
          </span>
        )}
        <span id={tooltipId} className="rule-chart__sr" aria-live="polite">
          {current === null ? '' : `${formatDay(current.date)}: ${formatBrl(current.price_cents)}`}
        </span>
      </div>
      <div className="rule-chart__axis" aria-hidden="true">
        <span>{formatDay(points[0].date)}</span>
        <span>{formatDay(points[points.length - 1].date)}</span>
      </div>
    </figure>
  )
}
