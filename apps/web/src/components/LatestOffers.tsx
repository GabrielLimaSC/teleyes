import { Link } from 'react-router-dom'
import type { Match, Rule } from '../api/types'
import { staggerStyle } from '../motion'
import { formatCurrency } from '../utils/savings'
import { formatMatchedAt } from '../utils/dates'
import { cardTitle } from './matchTitle'
import './LatestOffers.css'

const MAX_ITEMS = 5

/** S25-F1a (A1b): the newest offers on Início once the first steps are done or hidden. */
export function LatestOffers({ matches, rules }: { matches: Match[]; rules: Rule[] }) {
  const latest = [...matches]
    .sort((a, b) => b.matched_at.localeCompare(a.matched_at))
    .slice(0, MAX_ITEMS)
  return (
    <section className="plane-glass latest-offers" aria-labelledby="latest-offers-title">
      <div className="latest-offers__head">
        <h2 id="latest-offers-title">Últimas ofertas</h2>
        <Link className="latest-offers__all" to="/feed">
          Ver todas
        </Link>
      </div>
      {latest.length === 0 ? (
        <p className="latest-offers__empty">Quando uma promoção bater numa regra, ela aparece aqui.</p>
      ) : (
        <ul className="latest-offers__list">
          {latest.map((match, index) => {
            const title = cardTitle(
              match.message_text,
              rules.find((rule) => rule.id === match.rule_id),
            )
            const to = match.product_key !== null ? `/feed?produto=${encodeURIComponent(match.product_key)}` : '/feed'
            return (
              <li key={match.id} className="motion-item" style={staggerStyle(index)}>
                <Link className="latest-offers__item" to={to}>
                  <span className="latest-offers__main">
                    <span className="latest-offers__title">{title}</span>
                    <span className="latest-offers__when">{formatMatchedAt(match.matched_at)}</span>
                  </span>
                  <span className="latest-offers__side">
                    {match.target_hit && <span className="latest-offers__badge">alvo</span>}
                    {match.price_cents !== null && (
                      <span className="latest-offers__price">{formatCurrency(match.price_cents)}</span>
                    )}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
