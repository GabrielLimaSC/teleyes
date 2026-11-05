import type { ListenerStatus } from '../api/listener'
import type { Match, Recipient, Rule } from '../api/types'
import { EmptyState } from '../components/EmptyState'
import { ListenerApplyControl } from '../components/ListenerApplyControl'
import { describeListener } from '../components/listenerState'
import { RowActionsMenu } from '../components/RowActionsMenu'
import type { RowActionsMenuItem } from '../components/RowActionsMenu'
import { RuleHistoryChart } from '../components/RuleHistoryChart'
import { StatusToggle } from '../components/StatusToggle'
import { RULE_TEMPLATES } from '../rules/templates'
import { formatDayMonth, formatMatchedAt, isLater } from '../utils/dates'
import { ruleTargetState } from '../utils/target'
import { Avatar } from './RecipientDeliveryParts'
import { initial, recipientsLabel } from './recipientDelivery'
import './RegrasMobileList.css'

/** S24-03a: the phone layout of the rules list (screens 15, 16, 21, 22). */

export interface RecentMatches {
  ruleId: number
  matches: Match[] | null
  failed: boolean
}

const brl = (cents: number | null, empty: string): string =>
  cents === null ? empty : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

function latest(matches: Match[], count: number): Match[] {
  return [...matches]
    .sort((a, b) => (isLater(a.matched_at, b.matched_at) ? -1 : isLater(b.matched_at, a.matched_at) ? 1 : 0))
    .slice(0, count)
}

function TargetStatus({ rule }: { rule: Rule }) {
  const state = ruleTargetState(rule)
  if (state.kind === 'none') return null
  const text =
    state.kind === 'hit' ? 'atingido' : state.kind === 'gap' ? `falta ${state.gapPct}%` : 'sem oferta 24h'
  return (
    <span className={`rules-m__target-state rules-m__target-state--${state.kind}`}>{text}</span>
  )
}

function Who({ rule, recipients }: { rule: Rule; recipients: Recipient[] | null }) {
  const ids = rule.recipient_ids ?? []
  if (recipients === null) return ids.length > 0 ? <span className="rules-m__who">…</span> : null
  const known = recipients.filter((recipient) => ids.includes(recipient.id))
  const label = recipientsLabel(known.map((recipient) => recipient.name))
  return (
    <span className={label.none ? 'rules-m__who rules-m__who--none' : 'rules-m__who'}>
      {!label.none && (
        <span className="delivery-avatars">
          {known.slice(0, 3).map((recipient) => (
            <Avatar key={recipient.id} letter={initial(recipient.name)} title={recipient.name} />
          ))}
        </span>
      )}
      {label.text}
    </span>
  )
}

export function RegrasMobileSkeleton() {
  return (
    <div className="rules-m" role="status" aria-label="Carregando regras">
      {[0, 1, 2].map((key) => (
        <div key={key} className="rules-m__card rules-m__skeleton" aria-hidden="true">
          <span className="rules-m__bar rules-m__bar--title" />
          <span className="rules-m__bar" />
          <span className="rules-m__bar rules-m__bar--short" />
        </div>
      ))}
    </div>
  )
}

export function RegrasMobileList({
  rules,
  recipients,
  listener,
  expandedId,
  onToggleExpand,
  pausingId,
  onPause,
  onResume,
  menuItems,
  recent,
  onEdit,
  onTest,
  onCreate,
  onTemplate,
}: {
  rules: Rule[]
  recipients: Recipient[] | null
  listener: {
    status: ListenerStatus | null
    error: string | null
    requesting: boolean
    onApply: () => void
  }
  expandedId: number | null
  onToggleExpand: (id: number | null) => void
  pausingId: number | null
  onPause: (rule: Rule) => void
  onResume: (rule: Rule) => void
  menuItems: (rule: Rule) => RowActionsMenuItem[]
  recent: RecentMatches | null
  onEdit: (rule: Rule) => void
  onTest: (rule: Rule) => void
  onCreate: () => void
  onTemplate: (templateId: string) => void
}) {
  const pending = listener.status !== null && describeListener(listener.status).needsApply

  if (rules.length === 0) {
    return (
      <div className="rules-m">
        <EmptyState
          title="Nenhuma regra ainda"
          text="Uma regra diz o que procurar e até quanto pagar."
          action={{ label: 'Criar regra', onClick: onCreate }}
        />
        <p className="rules-m__or">ou comece de um modelo</p>
        <div className="rules-m__templates">
          {RULE_TEMPLATES.slice(0, 4).map((template) => (
            <button key={template.id} type="button" className="rules-m__chip" onClick={() => onTemplate(template.id)}>
              {template.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="rules-m">
      <div className={pending ? 'rules-m__apply rules-m__apply--pending' : 'rules-m__apply'}>
        {pending && <strong className="rules-m__apply-title">Mudanças não aplicadas</strong>}
        <ListenerApplyControl
          status={listener.status}
          error={listener.error}
          requesting={listener.requesting}
          onApply={listener.onApply}
        />
      </div>
      <ul className="rules-m__list">
        {rules.map((rule) => {
          const open = expandedId === rule.id
          const detailId = `rule-detail-${rule.id}`
          const own = recent !== null && recent.ruleId === rule.id ? recent : null
          return (
            <li
              key={rule.id}
              className={['plane-pearl rules-m__card', rule.active ? '' : 'rules-m__card--paused', open ? 'rules-m__card--open' : '']
                .filter(Boolean)
                .join(' ')}
            >
              <div className="rules-m__head">
                <div className="rules-m__title">
                  <span className="rules-m__name">{rule.name}</span>
                  <span className="rules-m__terms">{rule.include_terms}</span>
                </div>
                <StatusToggle
                  active={rule.active}
                  pausing={pausingId === rule.id}
                  onPause={() => onPause(rule)}
                  onResume={() => onResume(rule)}
                />
              </div>
              {rule.snoozed_until && (
                <span className="rule-silence rule-silence--muted">
                  <span aria-hidden="true" />
                  silenciada até {formatDayMonth(rule.snoozed_until)}
                </span>
              )}
              <dl className="rules-m__prices">
                <div>
                  <dt>Preço máximo</dt>
                  <dd>{brl(rule.max_price_cents, 'Sem preço máximo')}</dd>
                </div>
                <div>
                  <dt>Preço-alvo</dt>
                  <dd>{brl(rule.target_price_cents, '—')}</dd>
                </div>
              </dl>
              <div className="rules-m__delivery">
                <Who rule={rule} recipients={recipients} />
                <TargetStatus rule={rule} />
              </div>
              <div className="rules-m__footer">
                <button
                  type="button"
                  id={`rule-toggle-${rule.id}`}
                  className="plane-action plane-action--secondary rules-m__expand"
                  aria-expanded={open}
                  aria-controls={open ? detailId : undefined}
                  onClick={() => onToggleExpand(open ? null : rule.id)}
                >
                  {open ? 'Fechar' : 'Ver gráfico e ofertas'}
                </button>
                <RowActionsMenu label={`Mais ações da regra ${rule.name}`} items={menuItems(rule)} />
              </div>
              {open && (
                <div id={detailId} className="rules-m__detail" role="region" aria-label={`Detalhes da regra ${rule.name}`}>
                  <RuleHistoryChart
                    points={rule.history_30d ?? []}
                    ceilingCents={rule.max_price_cents}
                    targetCents={rule.target_price_cents}
                  />
                  <h3 className="rules-m__eyebrow">Últimas ofertas</h3>
                  {(own === null || (own.matches === null && !own.failed)) && (
                    <p role="status" className="rules-m__muted">Carregando ofertas…</p>
                  )}
                  {own?.failed && <p role="alert" className="rules-m__muted">Não foi possível carregar as ofertas.</p>}
                  {own?.matches?.length === 0 && <p className="rules-m__muted">Nenhuma oferta ainda para esta regra.</p>}
                  {own?.matches && own.matches.length > 0 && (
                    <ul className="rules-m__offers">
                      {latest(own.matches, 3).map((match) => (
                        <li key={match.id}>
                          <div className="rules-m__offer-main">
                            <strong>{brl(match.price_cents, '—')}</strong>
                            <span className="rules-m__offer-text">
                              {match.message_text} · {formatMatchedAt(match.matched_at)}
                            </span>
                          </div>
                          {match.message_link !== null && (
                            <a
                              className="rules-m__open"
                              href={match.message_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="Abrir mensagem"
                            >
                              Abrir ↗
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="rules-m__detail-actions">
                    <button type="button" className="plane-action plane-action--secondary" onClick={() => onEdit(rule)}>
                      Editar
                    </button>
                    <button type="button" className="plane-action plane-action--secondary" onClick={() => onTest(rule)}>
                      Testar
                    </button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
