import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import type { PurchaseInput } from '../api/purchases'
import { parsePriceInput } from '../utils/priceInput'
import { inputDateToApi, toDateInputValue } from '../utils/dates'
import type { LinkOption, PurchaseFormValues } from './purchaseDraft'

const SEARCH_DEBOUNCE_MS = 250

/**
 * S19-04: "Registrar compra" / "Editar compra". The link to a product or rule is
 * optional and picked by search; it only stores a key/id, never message content.
 */
export function PurchaseForm({
  title,
  initial,
  submitting,
  error,
  onSearch,
  onSubmit,
  onCancel,
}: {
  title: string
  initial: PurchaseFormValues
  submitting: boolean
  error: string | null
  onSearch: (query: string) => Promise<LinkOption[]>
  onSubmit: (input: PurchaseInput) => void
  onCancel: () => void
}) {
  const [values, setValues] = useState(initial)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<LinkOption[]>([])
  const [searching, setSearching] = useState(false)
  const listId = useId()
  const today = toDateInputValue(new Date())

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setOptions([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      setSearching(true)
      onSearch(trimmed)
        .then((found) => {
          if (!cancelled) setOptions(found)
        })
        .catch(() => {
          if (!cancelled) setOptions([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, onSearch])

  function pick(option: LinkOption) {
    setValues((current) => ({
      ...current,
      productKey: option.productKey,
      ruleId: option.ruleId,
      linkLabel: option.label,
      name: current.name.trim() === '' ? option.label : current.name,
    }))
    setQuery('')
    setOptions([])
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const name = values.name.trim()
    if (name === '') {
      setFieldError('Informe o nome ou a categoria da peça.')
      return
    }
    const price = parsePriceInput(values.price)
    if (price.error !== null) {
      setFieldError(price.error)
      return
    }
    if (values.day === '') {
      setFieldError('Informe a data da compra.')
      return
    }
    if (values.day > today) {
      setFieldError('A data da compra não pode estar no futuro.')
      return
    }
    setFieldError(null)
    const store = values.store.trim()
    onSubmit({
      name,
      price_cents: price.cents,
      purchased_at: inputDateToApi(values.day),
      store: store === '' ? null : store,
      product_key: values.productKey,
      rule_id: values.ruleId,
    })
  }

  const shownError = fieldError ?? error

  return (
    <form className="plane-pearl economia-form" onSubmit={submit} aria-label={title}>
      <h2>{title}</h2>
      <div className="economia-form__grid">
        <label>
          Peça ou categoria
          <input
            value={values.name}
            maxLength={120}
            placeholder="Placa-mãe B850M"
            onChange={(event) => setValues({ ...values, name: event.target.value })}
            required
          />
        </label>
        <label>
          Preço pago (R$)
          <input
            value={values.price}
            inputMode="decimal"
            placeholder="1.199,90"
            onChange={(event) => setValues({ ...values, price: event.target.value })}
            required
          />
        </label>
        <label>
          Data da compra
          <input
            type="date"
            value={values.day}
            max={today}
            onChange={(event) => setValues({ ...values, day: event.target.value })}
            required
          />
        </label>
        <label>
          Loja (opcional)
          <input
            value={values.store}
            maxLength={80}
            placeholder="Texto livre"
            onChange={(event) => setValues({ ...values, store: event.target.value })}
          />
        </label>
      </div>

      <div className="economia-form__link">
        {values.linkLabel !== null || values.productKey !== null || values.ruleId !== null ? (
          <p className="economia-form__linked">
            <span>
              Vinculada a: <strong>{values.linkLabel ?? values.productKey ?? `regra #${values.ruleId}`}</strong>
            </span>
            <button
              type="button"
              className="plane-action plane-action--secondary"
              onClick={() => setValues({ ...values, productKey: null, ruleId: null, linkLabel: null })}
            >
              Remover vínculo
            </button>
          </p>
        ) : (
          <label>
            Vincular a um produto ou regra (opcional)
            <input
              value={query}
              role="combobox"
              aria-expanded={options.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              placeholder="Busque pelo nome para comparar com os preços vistos"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}
        {(options.length > 0 || searching) && (
          <ul id={listId} role="listbox" className="economia-form__options" aria-label="Resultados da busca">
            {searching && options.length === 0 && <li className="economia-form__hint">Buscando…</li>}
            {options.map((option) => (
              <li key={`${option.kind}:${option.productKey ?? option.ruleId}`} role="presentation">
                <button type="button" role="option" aria-selected={false} onClick={() => pick(option)}>
                  <span className="economia-form__kind">{option.kind === 'rule' ? 'Regra' : 'Produto'}</span>
                  {option.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="economia-form__hint">
          Sem vínculo, só o valor pago entra no relatório; com vínculo, comparamos com os preços que o teleyes viu.
        </p>
      </div>

      <div className="economia-form__actions">
        <button type="submit" className="plane-action" disabled={submitting}>
          {submitting ? 'Salvando…' : 'Salvar compra'}
        </button>
        <button type="button" className="plane-action plane-action--secondary" onClick={onCancel} disabled={submitting}>
          Cancelar
        </button>
      </div>
      {shownError && (
        <p role="alert" className="economia-form__error">
          {shownError}
        </p>
      )}
    </form>
  )
}
