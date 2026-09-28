import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react'
import { fetchProduct } from '../api/products'
import { fetchEditableMatches, revertMatch, updateMatch } from '../api/matches'
import type { EditableMatch } from '../api/matches'
import { ApiError } from '../api/auth'
import type { Product, ProductHistoryRange, ProductPosting } from '../api/types'
import { formatClockMoment, formatDayMonth, formatMatchedAt } from '../utils/dates'
import { useIsProductPanelSheet } from '../hooks/useMediaQuery'
import { useAuth } from '../auth/AuthContext'
import { parsePriceInput } from '../utils/priceInput'
import './ProductPanel.css'

const RANGES: ProductHistoryRange[] = ['90d', '30d', '7d']
const RANGE_LABELS: Record<ProductHistoryRange, string> = { '90d': '90d', '30d': '30d', '7d': '7d' }

// Any control that opens/switches the panel (MatchCard's "Abrir produto" and
// the clickable title, HistoricoPage's row equivalents) carries this
// attribute — the panel's own "click outside closes it" listener (07b)
// ignores clicks on one of these instead of racing its own open()/close().
export const PRODUCT_OPEN_CONTROL_ATTR = 'data-product-open-control'

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatPriceInput(cents: number | null): string {
  if (cents === null) return ''
  const reais = Math.floor(cents / 100).toLocaleString('pt-BR')
  return `${reais},${String(cents % 100).padStart(2, '0')}`
}

function formatPriceForApi(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function HighlightedMessage({ message, title }: { message: string; title: string }) {
  const titlePattern = escapeRegExp(title)
  const pricePattern = String.raw`R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\b\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?\b`
  const pattern = new RegExp(`(${titlePattern}|${pricePattern})`, 'gi')
  const exactCandidate = new RegExp(`^(?:${titlePattern}|${pricePattern})$`, 'i')
  const parts = message.split(pattern)

  return (
    <>
      {parts.map((part, index) => {
        const isCandidate = exactCandidate.test(part)
        const isTitle = part.toLocaleLowerCase('pt-BR') === title.toLocaleLowerCase('pt-BR')
        return isCandidate ? (
          <mark
            key={`${index}-${part}`}
            style={{
              background:
                isTitle
                  ? 'color-mix(in srgb, var(--product-panel-accent) 35%, var(--product-panel-well-bg))'
                  : 'var(--plane-status-warn-bg)',
              boxShadow: isTitle ? 'inset 0 -2px var(--product-panel-accent)' : undefined,
              color: 'var(--plane-text-primary)',
              fontWeight: 600,
            }}
          >
            {part}
          </mark>
        ) : (
          <span key={`${index}-${part}`}>{part}</span>
        )
      })}
    </>
  )
}

interface ProductEditorProps {
  match: EditableMatch
  product: Product
  onCancel: () => void
  onSaved: (match: EditableMatch) => void
  onReverted: (match: EditableMatch) => void
}

function ProductEditor({ match, product, onCancel, onSaved, onReverted }: ProductEditorProps) {
  const { csrfToken } = useAuth()
  const [name, setName] = useState(match.display_name ?? product.title)
  const [price, setPrice] = useState(formatPriceInput(match.price_cents))
  const [applyNameToProduct, setApplyNameToProduct] = useState(false)
  const [nameTouched, setNameTouched] = useState(false)
  const [priceTouched, setPriceTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [nameServerError, setNameServerError] = useState<string | null>(null)
  const [priceServerError, setPriceServerError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const trimmedName = name.trim()
  const nameError =
    trimmedName.length < 3 || trimmedName.length > 120
      ? 'O nome deve ter entre 3 e 120 caracteres.'
      : null
  const parsedPrice = parsePriceInput(price)
  const priceError = parsedPrice.error
  const canSubmit = !nameError && !priceError && !submitting && !reverting
  const canRevert =
    match.price_source === 'manual' || match.display_name !== null || match.model_variant !== null

  function surfaceServerError(error: unknown): void {
    const message = error instanceof ApiError ? error.message : 'Não foi possível salvar a correção.'
    if (/nome|display_name/i.test(message)) setNameServerError(message)
    else if (/preço|price/i.test(message)) setPriceServerError(message)
    else setFormError(message)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setNameTouched(true)
    setPriceTouched(true)
    setNameServerError(null)
    setPriceServerError(null)
    setFormError(null)
    if (!canSubmit || parsedPrice.cents === null) return
    if (csrfToken === null) {
      setFormError('Sua sessão não tem um token de segurança. Atualize a página e entre novamente.')
      return
    }

    setSubmitting(true)
    try {
      const saved = await updateMatch(csrfToken, match.id, {
        display_name: trimmedName,
        price: formatPriceForApi(parsedPrice.cents),
        apply_name_to_product: applyNameToProduct,
      })
      onSaved(saved)
    } catch (error) {
      surfaceServerError(error)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevert() {
    setNameServerError(null)
    setPriceServerError(null)
    setFormError(null)
    if (csrfToken === null) {
      setFormError('Sua sessão não tem um token de segurança. Atualize a página e entre novamente.')
      return
    }

    setReverting(true)
    try {
      onReverted(await revertMatch(csrfToken, match.id))
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Não foi possível reverter ao valor detectado.',
      )
    } finally {
      setReverting(false)
    }
  }

  const fieldStyle = {
    width: '100%',
    height: 42,
    borderRadius: 10,
    border: '1px solid var(--glass-inner-border-color)',
    background: 'var(--product-panel-well-bg)',
    color: 'var(--plane-text-primary)',
    padding: '0 12px',
    font: 'inherit',
    boxSizing: 'border-box' as const,
  }
  const helperStyle = { margin: 0, fontSize: 11, lineHeight: 1.45, color: 'var(--plane-text-helper)' }
  const errorStyle = { ...helperStyle, color: 'var(--plane-status-danger)' }

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div
        style={{
          borderRadius: 14,
          padding: 14,
          background: 'var(--product-panel-well-bg)',
          border: '1px solid var(--product-panel-border-color)',
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
        }}
      >
        <div className="product-panel__label">Texto original da mensagem (somente leitura)</div>
        <div
          data-testid="original-message"
          style={{
            borderRadius: 10,
            padding: '10px 12px',
            background: 'var(--glass-tile-bg)',
            border: '1px solid var(--glass-inner-border-color)',
            color: 'var(--plane-text-primary)',
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: 12,
            lineHeight: 1.6,
            overflowWrap: 'anywhere',
          }}
        >
          <HighlightedMessage message={match.message_text} title={product.title} />
        </div>
        <p style={helperStyle}>O título e o trecho candidato a preço ficam destacados para conferência.</p>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="product-panel__label">Nome exibido</span>
        <input
          aria-label="Nome exibido"
          value={name}
          maxLength={120}
          aria-invalid={Boolean((nameTouched && nameError) || nameServerError)}
          aria-describedby={`product-name-help${(nameTouched && nameError) || nameServerError ? ' product-name-error' : ''}`}
          onChange={(event) => {
            setName(event.target.value)
            setNameServerError(null)
          }}
          onBlur={() => setNameTouched(true)}
          autoFocus={match.price_cents !== null}
          style={fieldStyle}
        />
        <span id="product-name-help" style={helperStyle}>Substitui o título bruto no feed, no histórico e no digest.</span>
        {(nameTouched && nameError) || nameServerError ? (
          <span id="product-name-error" role="alert" style={errorStyle}>{nameServerError ?? nameError}</span>
        ) : null}
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="product-panel__label">Preço</span>
        <span style={{ position: 'relative', display: 'block' }}>
          <span
            aria-hidden="true"
            style={{ position: 'absolute', left: 12, top: 12, color: 'var(--plane-text-helper)', fontSize: 14 }}
          >
            R$
          </span>
          <input
            aria-label="Preço"
            value={price}
            inputMode="decimal"
            aria-invalid={Boolean((priceTouched && priceError) || priceServerError)}
            aria-describedby={`product-price-help${(priceTouched && priceError) || priceServerError ? ' product-price-error' : ''}`}
            onChange={(event) => {
              setPrice(event.target.value)
              setPriceServerError(null)
            }}
            onBlur={() => setPriceTouched(true)}
            autoFocus={match.price_cents === null}
            style={{ ...fieldStyle, height: 46, paddingLeft: 39, fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
          />
        </span>
        <span id="product-price-help" style={helperStyle}>Aceita 5.749,00 ou 5749. O valor precisa ser maior que zero.</span>
        {(priceTouched && priceError) || priceServerError ? (
          <span id="product-price-error" role="alert" style={errorStyle}>{priceServerError ?? priceError}</span>
        ) : null}
      </label>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          minHeight: 44,
          padding: 12,
          borderRadius: 12,
          background: 'var(--glass-tile-bg)',
          border: '1px solid var(--glass-inner-border-color)',
          color: 'var(--plane-text-primary)',
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <span>Aplicar o nome a todos os matches deste produto</span>
        <button
          type="button"
          className="plane-action"
          role="switch"
          aria-label="Aplicar o nome a todos os matches deste produto"
          aria-checked={applyNameToProduct}
          onClick={() => setApplyNameToProduct((current) => !current)}
          style={{
            width: 34,
            height: 20,
            flex: 'none',
            padding: 2,
            border: 0,
            borderRadius: 999,
            background: applyNameToProduct ? 'var(--plane-status-good)' : 'var(--glass-divider-bg)',
            display: 'flex',
            justifyContent: applyNameToProduct ? 'flex-end' : 'flex-start',
            cursor: 'pointer',
          }}
        >
          <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: '50%', background: 'var(--toggle-knob-bg)' }} />
        </button>
      </div>

      <p style={helperStyle}>
        {match.last_correction ? (
          <>
            Última correção: {formatClockMoment(match.last_correction.created_at)} · valor detectado original:{' '}
            <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>
              {match.original_price_cents === null ? 'não identificado' : formatCurrency(match.original_price_cents)}
            </span>
          </>
        ) : (
          'Ainda não há correções manuais neste match.'
        )}
      </p>

      {formError && <p role="alert" style={{ ...errorStyle, fontSize: 12 }}>{formError}</p>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <button type="submit" className="plane-action" disabled={!canSubmit} style={{ flex: '1 1 150px', minHeight: 42 }}>
          {submitting ? 'Salvando…' : 'Salvar correção'}
        </button>
        <button type="button" className="plane-action plane-action--secondary" onClick={onCancel} disabled={submitting || reverting} style={{ minHeight: 42 }}>
          Cancelar
        </button>
        <button type="button" className="plane-action plane-action--secondary" onClick={handleRevert} disabled={!canRevert || submitting || reverting} style={{ minHeight: 42 }}>
          {reverting ? 'Revertendo…' : 'Reverter ao detectado'}
        </button>
      </div>
    </form>
  )
}

interface TargetEditorProps {
  /** `null` with no target yet — starts the field empty, same as
   * MatchCard's "Definir alvo". */
  targetPriceCents: number | null
  ruleName?: string
  onSave: (targetCents: number) => void
}

/** S14-08 parte 2 (rodada 2) / tela 07 "Alvo de preço": the panel's own
 * "Avise-me abaixo de" field + "Salvar alvo" — same inline-parse-on-submit
 * shape as MatchCard's "Definir alvo" (`utils/priceInput.ts`'s `{cents,
 * error}`, no full-form validation state needed for a single field). The
 * page (`onSave`) owns the actual `PATCH /rules/{id}` and its own success/
 * failure toast; this only ever blocks on a malformed value it can catch
 * before that call is even made. */
function TargetEditor({ targetPriceCents, ruleName, onSave }: TargetEditorProps) {
  const [value, setValue] = useState(formatPriceInput(targetPriceCents))
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()

  // A different rule's target (product switch, or the page's own reload
  // after a save) always replaces whatever was mid-typing — never merges
  // with it, so this never shows a stale value next to a fresh rule name.
  useEffect(() => {
    setValue(formatPriceInput(targetPriceCents))
    setError(null)
  }, [targetPriceCents, ruleName])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = parsePriceInput(value)
    if (parsed.cents === null) {
      setError(parsed.error)
      return
    }
    setError(null)
    onSave(parsed.cents)
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {ruleName && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--plane-text-helper)' }}>Regra: {ruleName}</p>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ flex: '1 1 160px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="product-panel__label">Avise-me abaixo de</span>
          <span style={{ position: 'relative', display: 'block' }}>
            <span
              aria-hidden="true"
              style={{ position: 'absolute', left: 12, top: 13, color: 'var(--plane-text-helper)', fontSize: 14 }}
            >
              R$
            </span>
            <input
              aria-label="Avise-me abaixo de"
              value={value}
              inputMode="decimal"
              placeholder="5.749,00"
              aria-invalid={error !== null}
              aria-describedby={error !== null ? errorId : undefined}
              onChange={(event) => {
                setValue(event.target.value)
                setError(null)
              }}
              style={{
                width: '100%',
                height: 42,
                borderRadius: 10,
                border: '1px solid var(--glass-inner-border-color)',
                background: 'var(--product-panel-well-bg)',
                color: 'var(--plane-text-primary)',
                padding: '0 12px 0 39px',
                font: 'inherit',
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                boxSizing: 'border-box',
              }}
            />
          </span>
        </label>
        <button type="submit" className="plane-action" style={{ minHeight: 42 }}>
          Salvar alvo
        </button>
      </div>
      {error !== null && (
        <p id={errorId} role="alert" style={{ margin: 0, fontSize: 11, color: 'var(--plane-status-danger)' }}>
          {error}
        </p>
      )}
    </form>
  )
}

/** `PricePoint.date` already comes as `YYYY-MM-DD` in the display timezone
 * (the backend's `series_for_range`) — a plain string split, never a `Date`
 * (the display timezone already equals the viewer's local one, so a round
 * trip through `parseApiDate`, which expects a UTC instant, would risk an
 * off-by-one day right around midnight for no reason). */
function formatSeriesDate(day: string): string {
  const [, month, dayOfMonth] = day.split('-')
  return `${dayOfMonth}/${month}`
}

type Status = 'loading' | 'ready' | 'not-found' | 'error'

interface ChartGeometry {
  points: string
  lastX: number
  lastY: number
}

const CHART_WIDTH = 440
const CHART_HEIGHT = 150
const CHART_PAD_Y = 16

function buildChartGeometry(series: Product['series']): ChartGeometry | null {
  const priced = series.filter((point) => point.price_cents !== null)
  if (priced.length === 0) return null
  const prices = priced.map((point) => point.price_cents)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const span = max - min

  const coords = priced.map((point, index) => {
    const x = priced.length === 1 ? CHART_WIDTH / 2 : (index / (priced.length - 1)) * CHART_WIDTH
    const norm = span === 0 ? 0.5 : (point.price_cents - min) / span
    const y = CHART_PAD_Y + (1 - norm) * (CHART_HEIGHT - CHART_PAD_Y * 2)
    return { x, y }
  })

  const last = coords[coords.length - 1]
  return {
    points: coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
    lastX: last.x,
    lastY: last.y,
  }
}

export interface ProductPanelProps {
  productKey: string
  /** `'open'` while entering/settled, `'closing'` during the 07b exit
   * animation — the parent only renders `ProductPanel` at all once it has
   * opened at least once, and keeps it mounted through `'closing'` so the
   * exit transition has something to animate. */
  phase: 'open' | 'closing'
  onClose: () => void
  /** S14-08 parte 2 (rodada 2): the page resolves which rule this saves to
   * (the product's most-recently-matched rule, `utils/productMatch.ts`) and
   * owns the actual `PATCH /rules/{id}` — this only carries the parsed
   * cents up. Each block below only renders once its handler is actually
   * passed, so nothing here is ever a fake button. */
  onSaveTarget?: (targetCents: number) => void
  onCreateRule?: () => void
  onSnooze?: () => void
  onEditData?: () => void
  /** Current target of the rule `onSaveTarget` will PATCH, `null`/omitted
   * for "no target yet" — prefills "Avise-me abaixo de". Ignored while
   * `onSaveTarget` is unset (the whole block is hidden then). */
  targetPriceCents?: number | null
  /** Name of that same rule — shown next to the field so a product with
   * more than one rule never saves a target to the wrong one silently. */
  targetRuleName?: string
  /** Whether the product is silenced right now — swaps the "Silenciar 7
   * dias" chip's label for "Reativar", same wording as MatchCard's own
   * toggle. The page still owns which call (`snoozeProduct`/
   * `reactivateSnooze`) `onSnooze` makes. */
  snoozed?: boolean
  /** Fires after `onEditData`'s own in-panel save/revert lands (S14-08
   * parte 2 rodada 2) — the page's own match list (Feed's live `matches`,
   * Histórico's filtered one) has no idea the panel just changed a price/
   * name until it refetches; this is that signal. */
  onEdited?: (match: EditableMatch) => void
}

export function ProductPanel({
  productKey,
  phase,
  onClose,
  onSaveTarget,
  onCreateRule,
  onSnooze,
  onEditData,
  targetPriceCents = null,
  targetRuleName,
  snoozed = false,
  onEdited,
}: ProductPanelProps) {
  const headingId = useId()
  const panelRef = useRef<HTMLElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const focusedOnceRef = useRef(false)
  const editRequestIdRef = useRef(0)
  const isSheet = useIsProductPanelSheet()

  // The panel mounts already at its "entering" (pre-transition) styles; two
  // rAFs later it flips to "entered" so the browser has committed the first
  // style before the transition-triggering one lands (07b's translateX/
  // opacity entrance — without this the very first paint would already be
  // the end state and no transition would ever run).
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [])
  const visualPhase = phase === 'closing' ? 'closing' : entered ? 'open' : 'entering'

  const [range, setRange] = useState<ProductHistoryRange>('90d')
  const [product, setProduct] = useState<Product | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [rangeLoading, setRangeLoading] = useState(false)
  const [showPostings, setShowPostings] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editableMatch, setEditableMatch] = useState<EditableMatch | null>(null)
  const [editLoading, setEditLoading] = useState(false)
  const [editLoadError, setEditLoadError] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const dragStartYRef = useRef(0)
  const draggingRef = useRef(false)
  // Mirrors `dragOffset` synchronously — `pointerup` needs the offset from
  // the *last* `pointermove`, and on a fast swipe (exactly what "drag to
  // close" is for) `pointerup` can land before React has committed that
  // move's `setDragOffset`, so reading the `dragOffset` state there closed
  // over a stale value and silently kept the panel open. `dragOffset` state
  // stays for the visual translateY while dragging; this ref is the only
  // thing `pointerup`/`pointercancel` ever read.
  const dragOffsetRef = useRef(0)

  // New product: reset everything and start from 90d, per the comp's
  // default tab.
  useEffect(() => {
    setRange('90d')
    setProduct(null)
    setStatus('loading')
    setErrorMessage(null)
    setShowPostings(false)
    setEditing(false)
    setEditableMatch(null)
    setEditLoading(false)
    setEditLoadError(null)
    editRequestIdRef.current += 1
  }, [productKey])

  // Loads whenever the product or the selected range changes. `cancelled`
  // guards against a slow request resolving after a newer one started (a
  // fast product switch, or a range click before the previous one landed).
  useEffect(() => {
    let cancelled = false
    if (product !== null) setRangeLoading(true)
    fetchProduct(productKey, range)
      .then((data) => {
        if (cancelled) return
        setProduct(data)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 404) {
          setStatus('not-found')
          return
        }
        setStatus('error')
        setErrorMessage(
          error instanceof ApiError ? error.message : 'Não foi possível carregar o produto.',
        )
      })
      .finally(() => {
        if (!cancelled) setRangeLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productKey, range])

  // Focus goes to the panel's heading once, when it first opens — never
  // again on a later product switch or range change (07b).
  useEffect(() => {
    if (focusedOnceRef.current) return
    headingRef.current?.focus()
    focusedOnceRef.current = true
  }, [])

  // Esc and click-outside close the panel (07b). A pointerdown on another
  // card's open control is not "outside" in the sense that matters here —
  // that control's own onClick already calls open()/switches the product,
  // so treating it as a close would just fight that.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Element | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if (target.closest(`[${PRODUCT_OPEN_CONTROL_ATTR}]`)) return
      onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [onClose])

  // The background only stops scrolling in the full-screen sheet (<960px) —
  // the desktop split keeps the feed scrollable behind the panel (07b).
  useEffect(() => {
    if (!isSheet) return
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [isSheet])

  function handleGrabberPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isSheet) return
    draggingRef.current = true
    dragStartYRef.current = event.clientY
    dragOffsetRef.current = 0
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleGrabberPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return
    const offset = Math.max(0, event.clientY - dragStartYRef.current)
    dragOffsetRef.current = offset
    setDragOffset(offset)
  }

  function handleGrabberPointerUp() {
    if (!draggingRef.current) return
    draggingRef.current = false
    const shouldClose = dragOffsetRef.current > 96
    dragOffsetRef.current = 0
    setDragOffset(0)
    if (shouldClose) onClose()
  }

  // A cancelled gesture (pointer capture lost to the OS/browser mid-drag,
  // e.g. an edge-swipe navigation) is not a close decision — just snap the
  // sheet back like an under-threshold drag, without ever calling onClose().
  function handleGrabberPointerCancel() {
    if (!draggingRef.current) return
    draggingRef.current = false
    dragOffsetRef.current = 0
    setDragOffset(0)
  }

  async function handleEditData() {
    onEditData?.()
    if (!product) return
    setEditing(true)
    setEditLoading(true)
    setEditLoadError(null)
    const requestId = ++editRequestIdRef.current
    try {
      const matches = await fetchEditableMatches()
      if (requestId !== editRequestIdRef.current) return
      const newestPostingId = product.postings[0]?.id
      const selected =
        matches.find((match) => match.id === newestPostingId) ??
        matches.find((match) => match.product_key === product.product_key)
      if (!selected) {
        setEditableMatch(null)
        setEditLoadError('Não foi possível localizar o match mais recente deste produto para edição.')
        return
      }
      setEditableMatch(selected)
    } catch (error) {
      if (requestId !== editRequestIdRef.current) return
      setEditLoadError(
        error instanceof ApiError ? error.message : 'Não foi possível carregar os dados para edição.',
      )
    } finally {
      if (requestId === editRequestIdRef.current) setEditLoading(false)
    }
  }

  async function refreshProduct(match: EditableMatch) {
    setEditableMatch(match)
    setProduct((current) =>
      current?.product_key === match.product_key
        ? {
            ...current,
            title: match.display_name ?? current.title,
            current_price_cents: match.price_cents,
            postings: current.postings.map((posting) =>
              posting.id === match.id ? { ...posting, price_cents: match.price_cents } : posting,
            ),
          }
        : current,
    )
    try {
      const refreshed = await fetchProduct(productKey, range)
      setProduct((current) =>
        current?.product_key === refreshed.product_key
          ? { ...refreshed, title: match.display_name ?? refreshed.title }
          : current,
      )
    } catch {
      // The write succeeded and the returned match is already reflected above.
      // A later range change retries the product aggregate request normally.
    }
  }

  function handleSaved(match: EditableMatch) {
    void refreshProduct(match)
    setEditing(false)
    onEdited?.(match)
  }

  function handleReverted(match: EditableMatch) {
    void refreshProduct(match)
    setEditing(false)
    onEdited?.(match)
  }

  const chart = product ? buildChartGeometry(product.series) : null

  return (
    <>
      {isSheet && <div className={'product-panel-backdrop' + (phase === 'closing' ? ' product-panel-backdrop--closing' : '')} />}
      <section
      ref={panelRef}
      className={'product-panel' + (isSheet ? ' product-panel--sheet' : '')}
      data-phase={visualPhase}
      role="dialog"
      aria-modal={isSheet}
      aria-labelledby={headingId}
      style={isSheet && dragOffset > 0 ? { transform: `translateY(${dragOffset}px)`, transition: 'none' } : undefined}
    >
      {isSheet && (
        <div
          className="product-panel__grabber"
          onPointerDown={handleGrabberPointerDown}
          onPointerMove={handleGrabberPointerMove}
          onPointerUp={handleGrabberPointerUp}
          onPointerCancel={handleGrabberPointerCancel}
        >
          <span className="product-panel__grabber-bar" aria-hidden="true" />
        </div>
      )}

      <div className="product-panel__header">
        <div className="product-panel__header-info" key={productKey}>
          {!editing && (
            <div className="product-panel__icon" aria-hidden="true">
              <span className="product-panel__icon-mark" />
            </div>
          )}
          <div className="product-panel__header-text">
            {editing && product && (
              <div style={{ marginBottom: 5, color: 'var(--plane-text-eyebrow)', fontSize: 11, fontWeight: 700, letterSpacing: '.09em', textTransform: 'uppercase' }}>
                Editando produto
              </div>
            )}
            <h2 id={headingId} ref={headingRef} tabIndex={-1} className="product-panel__title">
              {editing && product ? editableMatch?.display_name ?? product.title : product?.title ?? 'Carregando produto…'}
            </h2>
            {product && !editing && (
              <p className="product-panel__subtitle">
                {product.total_count} {product.total_count === 1 ? 'registro' : 'registros'} desde{' '}
                {formatDayMonth(product.first_seen_at)} · {product.sources.length}{' '}
                {product.sources.length === 1 ? 'fonte' : 'fontes'}
              </p>
            )}
          </div>
        </div>
        {!editing && product && (
          <button type="button" className="plane-action plane-action--secondary product-panel__chip" onClick={handleEditData}>
            Editar dados
          </button>
        )}
        <button
          type="button"
          className="product-panel__close"
          onClick={onClose}
          aria-label="Fechar painel do produto"
          style={editing ? { marginRight: 44 } : undefined}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <div className="product-panel__body" key={productKey}>
        {status === 'loading' && <p className="product-panel__status">Carregando…</p>}
        {status === 'not-found' && (
          <p className="product-panel__status" role="alert">
            Produto não encontrado — pode ter sido removido.
          </p>
        )}
        {status === 'error' && (
          <p className="product-panel__status product-panel__status--error" role="alert">
            {errorMessage}
          </p>
        )}

        {status === 'ready' && product && editing && (
          <>
            {editLoading && <p className="product-panel__status">Carregando edição…</p>}
            {editLoadError && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <p className="product-panel__status product-panel__status--error" role="alert">
                  {editLoadError}
                </p>
                <button type="button" className="plane-action plane-action--secondary" onClick={handleEditData}>
                  Tentar novamente
                </button>
              </div>
            )}
            {!editLoading && !editLoadError && editableMatch && (
              <ProductEditor
                key={`${editableMatch.id}-${editableMatch.last_correction?.created_at ?? 'new'}`}
                match={editableMatch}
                product={product}
                onCancel={() => setEditing(false)}
                onSaved={handleSaved}
                onReverted={handleReverted}
              />
            )}
          </>
        )}

        {status === 'ready' && product && !editing && (
          <>
            <div className="product-panel__well">
              <div className="product-panel__price-row">
                <div>
                  <div className="product-panel__label">Preço atual</div>
                  <div className="product-panel__current-price">
                    {product.current_price_cents !== null ? formatCurrency(product.current_price_cents) : 'Sem preço identificado'}
                  </div>
                </div>
                <div className="product-panel__tabs" role="tablist" aria-label="Período do histórico">
                  {RANGES.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      role="tab"
                      aria-selected={range === candidate}
                      className={
                        'product-panel__range-tab plane-action' +
                        (range === candidate ? '' : ' plane-action--secondary')
                      }
                      onClick={() => setRange(candidate)}
                    >
                      {RANGE_LABELS[candidate]}
                    </button>
                  ))}
                </div>
              </div>

              {chart ? (
                <>
                  <svg
                    viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                    width="100%"
                    height={CHART_HEIGHT}
                    preserveAspectRatio="none"
                    className={'product-panel__chart' + (rangeLoading ? ' product-panel__chart--loading' : '')}
                    role="img"
                    aria-label={`Histórico de preço, ${RANGE_LABELS[range]}`}
                  >
                    <line x1="0" y1="30" x2={CHART_WIDTH} y2="30" className="product-panel__chart-grid" />
                    <line x1="0" y1="70" x2={CHART_WIDTH} y2="70" className="product-panel__chart-grid" />
                    <line x1="0" y1="110" x2={CHART_WIDTH} y2="110" className="product-panel__chart-grid" />
                    <polyline points={chart.points} className="product-panel__chart-line" />
                    <circle cx={chart.lastX} cy={chart.lastY} r="4" className="product-panel__chart-dot" />
                  </svg>
                  <div className="product-panel__chart-axis">
                    <span>{formatSeriesDate(product.series[0].date)}</span>
                    <span>hoje</span>
                  </div>
                </>
              ) : (
                <p className="product-panel__status">Sem histórico de preço suficiente ainda.</p>
              )}
            </div>

            <div className="product-panel__stats">
              <div className="product-panel__stat">
                <div className="product-panel__label">Menor 90d</div>
                <div className="product-panel__stat-value">
                  {product.lowest_90d_cents !== null ? formatCurrency(product.lowest_90d_cents) : '—'}
                </div>
              </div>
              <div className="product-panel__stat">
                <div className="product-panel__label">Média 30d</div>
                <div className="product-panel__stat-value">
                  {product.average_30d_cents !== null ? formatCurrency(product.average_30d_cents) : '—'}
                </div>
              </div>
              <div className="product-panel__stat">
                <div className="product-panel__label">Maior 90d</div>
                <div className="product-panel__stat-value">
                  {product.highest_90d_cents !== null ? formatCurrency(product.highest_90d_cents) : '—'}
                </div>
              </div>
            </div>

            {onSaveTarget && (
              <div className="product-panel__well product-panel__target">
                <div className="product-panel__label">Alvo de preço</div>
                <TargetEditor targetPriceCents={targetPriceCents} ruleName={targetRuleName} onSave={onSaveTarget} />
              </div>
            )}

            <div className="product-panel__actions">
              {onCreateRule && (
                <button type="button" className="plane-action plane-action--secondary product-panel__chip" onClick={onCreateRule}>
                  Criar regra disso
                </button>
              )}
              {onSnooze && (
                <button type="button" className="plane-action plane-action--secondary product-panel__chip" onClick={onSnooze}>
                  {snoozed ? 'Reativar' : 'Silenciar 7 dias'}
                </button>
              )}
              {product.postings.length > 0 && (
                <button
                  type="button"
                  className="plane-action plane-action--secondary product-panel__chip"
                  aria-expanded={showPostings}
                  onClick={() => setShowPostings((current) => !current)}
                >
                  Ver as {product.total_count} {product.total_count === 1 ? 'postagem' : 'postagens'}
                </button>
              )}
            </div>

            {showPostings && (
              <ul className="product-panel__postings">
                {product.postings.map((posting: ProductPosting) => (
                  <li key={posting.id} className="product-panel__posting">
                    <span className="product-panel__posting-source">{posting.source_name}</span>
                    <span className="product-panel__posting-price">
                      {posting.price_cents !== null ? formatCurrency(posting.price_cents) : 'Preço não identificado'}
                    </span>
                    <span className="product-panel__posting-date">{formatMatchedAt(posting.matched_at)}</span>
                    {posting.message_link ? (
                      <a
                        className="product-panel__posting-link"
                        href={posting.message_link}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Abrir
                      </a>
                    ) : (
                      <span className="product-panel__posting-nolink">Sem link</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      </section>
    </>
  )
}
