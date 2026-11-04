import type { ReportItem } from '../api/purchases'
import { formatCurrency, referenceMarkerLabel } from '../utils/savings'

/**
 * S22-01: replaces the range bar of a purchase that has no teleyes history but has a
 * reference typed by the user. It is a plain two-point marker, deliberately not a
 * "seen range": the reference is the user's own number, not a price the app saw.
 */
export function ReferenceMarker({ item }: { item: ReportItem }) {
  const reference = item.reference
  if (!reference) return null
  const paid = item.price_cents
  const low = Math.min(paid, reference.price_cents)
  const high = Math.max(paid, reference.price_cents)
  const span = high - low
  const position = (cents: number) => (span <= 0 ? 50 : 8 + ((cents - low) / span) * 84)
  return (
    <div className="price-range price-range--reference" data-testid="reference-marker">
      <div className="price-range__track">
        <span
          className="price-range__reference"
          style={{ left: `${position(reference.price_cents)}%` }}
          aria-hidden="true"
        />
        <span
          className={`price-range__paid price-range__paid--${paid > reference.price_cents ? 'bad' : 'good'}`}
          style={{ left: `${position(paid)}%` }}
          role="img"
          aria-label={`Você pagou ${formatCurrency(paid)}`}
        />
      </div>
      <div className="price-range__note price-range__note--reference">{referenceMarkerLabel(reference)}</div>
    </div>
  )
}
