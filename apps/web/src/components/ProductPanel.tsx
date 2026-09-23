import { useEffect, useId, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { fetchProduct } from '../api/products'
import { ApiError } from '../api/auth'
import type { Product, ProductHistoryRange, ProductPosting } from '../api/types'
import { formatDayMonth, formatMatchedAt } from '../utils/dates'
import { useIsProductPanelSheet } from '../hooks/useMediaQuery'
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
  /** S14-08: hidden this delivery (their backend — S14-02/S14-03/S14-06 —
   * is not part of this PR). Each block only renders once its handler is
   * actually passed, so nothing here is ever a fake button. */
  onSaveTarget?: (targetCents: number) => void
  onCreateRule?: () => void
  onSnooze?: () => void
  onEditData?: () => void
}

export function ProductPanel({
  productKey,
  phase,
  onClose,
  onSaveTarget,
  onCreateRule,
  onSnooze,
  onEditData,
}: ProductPanelProps) {
  const headingId = useId()
  const panelRef = useRef<HTMLElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const focusedOnceRef = useRef(false)
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
  const [dragOffset, setDragOffset] = useState(0)
  const dragStartYRef = useRef(0)
  const draggingRef = useRef(false)

  // New product: reset everything and start from 90d, per the comp's
  // default tab.
  useEffect(() => {
    setRange('90d')
    setProduct(null)
    setStatus('loading')
    setErrorMessage(null)
    setShowPostings(false)
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
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleGrabberPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return
    setDragOffset(Math.max(0, event.clientY - dragStartYRef.current))
  }

  function handleGrabberPointerUp() {
    if (!draggingRef.current) return
    draggingRef.current = false
    const shouldClose = dragOffset > 96
    setDragOffset(0)
    if (shouldClose) onClose()
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
          onPointerCancel={handleGrabberPointerUp}
        >
          <span className="product-panel__grabber-bar" aria-hidden="true" />
        </div>
      )}

      <div className="product-panel__header">
        <div className="product-panel__header-info" key={productKey}>
          <div className="product-panel__icon" aria-hidden="true">
            <span className="product-panel__icon-mark" />
          </div>
          <div className="product-panel__header-text">
            <h2 id={headingId} ref={headingRef} tabIndex={-1} className="product-panel__title">
              {product?.title ?? 'Carregando produto…'}
            </h2>
            {product && (
              <p className="product-panel__subtitle">
                {product.total_count} {product.total_count === 1 ? 'registro' : 'registros'} desde{' '}
                {formatDayMonth(product.first_seen_at)} · {product.sources.length}{' '}
                {product.sources.length === 1 ? 'fonte' : 'fontes'}
              </p>
            )}
          </div>
        </div>
        {onEditData && product && (
          <button type="button" className="plane-action plane-action--secondary product-panel__chip" onClick={onEditData}>
            Editar dados
          </button>
        )}
        <button type="button" className="product-panel__close" onClick={onClose} aria-label="Fechar painel do produto">
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

        {status === 'ready' && product && (
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
                {/* S14-02 not part of this delivery: the input/"Salvar alvo"
                    controls arrive with that task, wired to this handler. */}
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
                  Silenciar 7 dias
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
