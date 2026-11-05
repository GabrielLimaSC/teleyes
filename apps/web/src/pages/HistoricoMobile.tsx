import { memo, useEffect, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet'
import { RowActionsMenu } from '../components/RowActionsMenu'
import { PRODUCT_OPEN_CONTROL_ATTR } from '../components/ProductPanel'
import { fetchMatches } from '../api/matches'
import type { MatchFilters, MatchSort } from '../api/matches'
import type { Delivery, Recipient, Rule, Source } from '../api/types'
import type { FilterForm } from './HistoricoPage'
import './HistoricoMobile.css'

/** S24-04b (telas 12/13): phone layout of the Histórico — list instead of the
 * table, filters in a bottom sheet. Presentation only; the page owns state. */

export interface MobileRow {
  id: number
  title: string
  productKey: string | null
  priceText: string
  priceDetails: string[]
  ruleName: string
  sourceName: string
  time: string
  link: string | null
  deliveries: Delivery[]
  deliveryLabel: string
  recipientNames: string[]
}

function deliveryKind(row: MobileRow): { text: string; reason: string | null; tone: 'ok' | 'info' | 'bad' } {
  const has = (status: string) => row.deliveries.some((delivery) => delivery.status === status)
  if (has('sent')) return { text: 'enviado', reason: null, tone: 'ok' }
  if (has('digest_attempted')) return { text: 'no resumo', reason: null, tone: 'info' }
  return { text: 'não enviado', reason: row.deliveryLabel, tone: 'bad' }
}

export const MobileHistoricoItem = memo(function MobileHistoricoItem({
  row,
  onOpenProduct,
  onRequestDelete,
}: {
  row: MobileRow
  onOpenProduct: (productKey: string, trigger: HTMLElement) => void
  onRequestDelete: (matchId: number) => void
}) {
  const delivery = deliveryKind(row)
  const title =
    row.productKey !== null ? (
      <button
        type="button"
        className="hist-m__title hist-m__title--button"
        {...{ [PRODUCT_OPEN_CONTROL_ATTR]: true }}
        onClick={(event) => onOpenProduct(row.productKey as string, event.currentTarget)}
      >
        {row.title}
      </button>
    ) : (
      <span className="hist-m__title">{row.title}</span>
    )
  return (
    <li className="hist-m__item">
      <div className="hist-m__main">
        {title}
        <span className="hist-m__meta">
          {row.ruleName} · {row.sourceName}
        </span>
        <span className="hist-m__price">
          {row.priceText}
          {row.priceDetails.map((detail) => (
            <span key={detail} className="hist-m__note">
              {detail}
            </span>
          ))}
        </span>
        <span className="hist-m__foot">
          <span className={`hist-m__delivery hist-m__delivery--${delivery.tone}`}>{delivery.text}</span>
          {delivery.reason !== null && <span className="hist-m__note">{delivery.reason}</span>}
          {row.recipientNames.length > 0 && <span className="hist-m__note">{row.recipientNames.join(', ')}</span>}
          <span className="hist-m__note">· {row.time}</span>
        </span>
      </div>
      <div className="hist-m__actions">
        {row.link !== null && (
          <a
            className="hist-m__icon-btn"
            href={row.link}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Abrir promoção: ${row.title}`}
          >
            <span aria-hidden="true">↗</span>
          </a>
        )}
        <RowActionsMenu
          label={`Mais ações: ${row.title}`}
          items={[{ key: 'delete', label: 'Excluir anúncio', danger: true, onSelect: () => onRequestDelete(row.id) }]}
        />
      </div>
    </li>
  )
})

const DELIVERY_SEGMENTS = [
  { value: '', label: 'Todas' },
  { value: 'sent', label: 'Enviado' },
  { value: 'digest_attempted', label: 'Resumo' },
  { value: 'failed', label: 'Não enviado' },
]

export const MOBILE_SORT_OPTIONS: Array<{ value: '' | MatchSort; label: string }> = [
  { value: '', label: 'Mais recentes' },
  { value: 'price_asc', label: 'Menor preço' },
  { value: 'price_desc', label: 'Maior preço' },
]

export function activeFilterChips(
  form: FilterForm,
  rules: Rule[],
  sources: Source[],
  recipients: Recipient[],
): Array<{ key: keyof FilterForm; label: string }> {
  const chips: Array<{ key: keyof FilterForm; label: string }> = []
  const name = (list: Array<{ id: number; name: string }>, id: string) =>
    list.find((item) => String(item.id) === id)?.name ?? `#${id}`
  if (form.ruleId) chips.push({ key: 'ruleId', label: `Regra: ${name(rules, form.ruleId)}` })
  if (form.sourceId) chips.push({ key: 'sourceId', label: `Grupo: ${name(sources, form.sourceId)}` })
  if (form.recipientId) chips.push({ key: 'recipientId', label: `Para: ${name(recipients, form.recipientId)}` })
  if (form.deliveryStatus) {
    const segment = DELIVERY_SEGMENTS.find((s) => s.value === form.deliveryStatus)
    chips.push({ key: 'deliveryStatus', label: `Entrega: ${(segment?.label ?? form.deliveryStatus).toLowerCase()}` })
  }
  if (form.minPriceReais) chips.push({ key: 'minPriceReais', label: `Mín. R$ ${form.minPriceReais}` })
  if (form.maxPriceReais) chips.push({ key: 'maxPriceReais', label: `Máx. R$ ${form.maxPriceReais}` })
  return chips
}

interface FiltersProps {
  form: FilterForm
  onApply: (next: FilterForm) => void
  rules: Rule[]
  sources: Source[]
  recipients: Recipient[]
  toApi: (form: FilterForm) => MatchFilters
}

export function HistoricoMobileFilters({ open, onClose, ...rest }: FiltersProps & { open: boolean; onClose: () => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Filtros">
      <FiltersBody
        {...rest}
        onApply={(next) => {
          rest.onApply(next)
          onClose()
        }}
      />
    </BottomSheet>
  )
}

function FiltersBody({ form, onApply, rules, sources, recipients, toApi }: FiltersProps) {
  const [draft, setDraft] = useState<FilterForm>(form)
  const [count, setCount] = useState<number | null>(null)
  const set = (field: keyof FilterForm) => (value: string) => setDraft((current) => ({ ...current, [field]: value }))

  // "Ver N anúncios": how many rows the draft would leave, before applying.
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      fetchMatches(toApi(draft))
        .then((data) => !cancelled && setCount(data.length))
        .catch(() => !cancelled && setCount(null))
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // toApi is rebuilt each render by the page; only the draft matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  return (
    <div className="hist-m-filters">
      <label>
        Regra
        <select aria-label="Regra" value={draft.ruleId} onChange={(e) => set('ruleId')(e.target.value)}>
          <option value="">Todas</option>
          {rules.map((rule) => (
            <option key={rule.id} value={rule.id}>
              {rule.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Grupo
        <select aria-label="Grupo" value={draft.sourceId} onChange={(e) => set('sourceId')(e.target.value)}>
          <option value="">Todos os grupos</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Destinatário
        <select aria-label="Destinatário" value={draft.recipientId} onChange={(e) => set('recipientId')(e.target.value)}>
          <option value="">Todos</option>
          {recipients.map((recipient) => (
            <option key={recipient.id} value={recipient.id}>
              {recipient.name}
            </option>
          ))}
        </select>
      </label>
      <div role="group" aria-label="Entrega" className="hist-m-filters__group">
        <span>Entrega</span>
        <div className="hist-m-filters__segments">
          {DELIVERY_SEGMENTS.map((segment) => (
            <button
              key={segment.value}
              type="button"
              aria-pressed={draft.deliveryStatus === segment.value}
              className="hist-m-filters__segment"
              onClick={() => set('deliveryStatus')(segment.value)}
            >
              {segment.label}
            </button>
          ))}
        </div>
      </div>
      <div className="hist-m-filters__prices">
        <label>
          Preço mínimo
          <input
            type="text"
            inputMode="decimal"
            aria-label="Preço mínimo (R$)"
            placeholder="R$ 0,00"
            value={draft.minPriceReais}
            onChange={(e) => set('minPriceReais')(e.target.value)}
          />
        </label>
        <label>
          Preço máximo
          <input
            type="text"
            inputMode="decimal"
            aria-label="Preço máximo (R$)"
            placeholder="R$ 0,00"
            value={draft.maxPriceReais}
            onChange={(e) => set('maxPriceReais')(e.target.value)}
          />
        </label>
      </div>
      <div className="hist-m-filters__footer">
        <button
          type="button"
          className="plane-action plane-action--secondary"
          onClick={() =>
            setDraft((current) => ({
              ...current,
              ruleId: '',
              sourceId: '',
              recipientId: '',
              deliveryStatus: '',
              minPriceReais: '',
              maxPriceReais: '',
            }))
          }
        >
          Limpar
        </button>
        <button type="button" className="plane-action fill-button" onClick={() => onApply(draft)}>
          {count === null ? 'Ver anúncios' : `Ver ${count} ${count === 1 ? 'anúncio' : 'anúncios'}`}
        </button>
      </div>
    </div>
  )
}
