import { Link } from 'react-router-dom'
import { RULE_TEMPLATES } from '../rules/templates'
import { staggerStyle } from '../motion'
import './FeedStates.css'

/** S25-F1a (A2c): skeletons sized like the rails and cards, so nothing jumps when data lands. */
export function FeedLoadingSkeleton() {
  return (
    <div className="feed-loading" aria-busy="true" aria-label="Carregando ofertas">
      <div className="plane-glass feed-loading__rail feed-loading__pulse" />
      <div className="feed-loading__list">
        <div className="feed-skeleton__card" />
        <div className="feed-skeleton__card" />
        <div className="feed-skeleton__card" />
      </div>
      <div className="plane-glass feed-loading__rail feed-loading__pulse" />
    </div>
  )
}

/** S25-F1a (A2): no rules yet — full-width empty state with template chips. */
export function NoRulesWide() {
  return (
    <section className="feed-norules motion-item"aria-labelledby="feed-norules-title">
      <h2 id="feed-norules-title" className="feed-norules__title">
        Nenhuma regra ainda
      </h2>
      <p className="feed-norules__text">
        Crie uma regra dizendo o que procurar e até quanto pagar. As ofertas aparecem aqui sozinhas.
      </p>
      <Link className="plane-action feed-norules__action" to="/regras?nova=1">
        Criar primeira regra
      </Link>
      <p className="feed-norules__or">ou comece de um modelo</p>
      <div className="feed-norules__chips">
        {RULE_TEMPLATES.map((template, index) => (
          <Link key={template.id} className="feed-norules__chip motion-item" style={staggerStyle(index)} to={`/regras?nova=1&modelo=${template.id}`}>
            {template.label}
          </Link>
        ))}
      </div>
    </section>
  )
}
