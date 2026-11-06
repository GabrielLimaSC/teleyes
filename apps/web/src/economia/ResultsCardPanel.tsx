import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useSegmentThumb } from '../motion/useSegmentThumb'
import type { SavingsReport } from '../api/purchases'
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  DEFAULT_CARD_OPTIONS,
  PERIOD_LABELS,
  canShareImage,
  buildResultsAggregates,
  buildResultsSvg,
  loadMascotDataUri,
  readCardPalette,
  resultsJson,
  shareImage,
  svgToDataUri,
  svgToPngBlob,
} from './resultsCard'
import type { CardOptions, CardPeriod } from './resultsCard'

const PERIODS: CardPeriod[] = ['month', '90d', 'all']

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * S19-04: preview and export of the results card (PNG + aggregates JSON). Everything
 * is built in the browser from the report already on screen; nothing is sent anywhere.
 */
export function ResultsCardPanel({
  report,
  onClose,
  embedded = false,
}: {
  report: SavingsReport
  onClose: () => void
  /** Phone: inside a BottomSheet, which provides the title and the close button. */
  embedded?: boolean
}) {
  const [options, setOptions] = useState<CardOptions>(DEFAULT_CARD_OPTIONS)
  const { containerRef: periodsRef, thumbRef: periodsThumbRef } = useSegmentThumb<HTMLDivElement>(options.period ?? 'all')
  const [mascot, setMascot] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const shareAvailable = useMemo(() => canShareImage(), [])

  useEffect(() => {
    let cancelled = false
    // The inverse mascot (dark card) when the repo has it; the original otherwise.
    loadMascotDataUri(`${import.meta.env.BASE_URL}mascot/mascote-inverse.png`)
      .then((uri) => uri ?? loadMascotDataUri(`${import.meta.env.BASE_URL}mascot.png`))
      .then((uri) => {
        if (!cancelled) setMascot(uri)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const aggregates = useMemo(() => buildResultsAggregates(report, options), [report, options])
  const svg = useMemo(
    () => buildResultsSvg(aggregates, readCardPalette(), mascot),
    [aggregates, mascot],
  )

  function downloadJson() {
    download(new Blob([resultsJson(aggregates)], { type: 'application/json' }), 'teleyes-economia.json')
  }

  function sharePng() {
    setBusy(true)
    setError(null)
    setNotice(null)
    svgToPngBlob(svg)
      .then((blob) => shareImage(blob))
      .then((outcome) => {
        if (outcome === 'copied') setNotice('Imagem copiada')
      })
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Não foi possível compartilhar a imagem.'),
      )
      .finally(() => setBusy(false))
  }

  function downloadPng() {
    setBusy(true)
    setError(null)
    svgToPngBlob(svg)
      .then((blob) => download(blob, 'teleyes-economia.png'))
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Não foi possível gerar a imagem.'),
      )
      .finally(() => setBusy(false))
  }

  useDialogFocus(dialogRef, !embedded)
  useEffect(() => {
    if (embedded) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [embedded, onClose])

  const empty = aggregates.totals.purchases === 0

  const panel = (
    <section
      ref={dialogRef}
      className={embedded ? 'economia-card-panel economia-card-panel--embedded' : 'plane-pearl economia-card-panel economia-card-panel--modal'}
      role={embedded ? undefined : 'dialog'}
      aria-modal={embedded ? undefined : true}
      aria-labelledby={embedded ? undefined : titleId}
      aria-label={embedded ? 'Cartão de resultados' : undefined}
      tabIndex={embedded ? undefined : -1}
    >
      {!embedded && (
        <div className="economia-card-panel__header">
          <h2 id={titleId}>Cartão de resultados</h2>
          <button type="button" className="plane-action plane-action--secondary" onClick={onClose}>
            Fechar
          </button>
        </div>
      )}
      <p className="economia-card-panel__note">
        A imagem ({CARD_WIDTH}×{CARD_HEIGHT}) e o JSON levam só números agregados: nunca nomes de grupos,
        mensagens ou links.
      </p>
      <div className="economia-card-panel__body">
        <fieldset className="economia-card-panel__options">
          <legend>Período</legend>
          <div ref={periodsRef} className="economia-card-panel__periods motion-seg" role="radiogroup" aria-label="Período">
            <span ref={periodsThumbRef} className="motion-seg__thumb" aria-hidden="true" />
            {PERIODS.map((period) => (
              <button
                key={period}
                type="button"
                role="radio"
                aria-checked={(options.period ?? 'all') === period}
                className="economia-card-panel__period"
                onClick={() => {
                  setNotice(null)
                  setOptions({ ...options, period })
                }}
              >
                {PERIOD_LABELS[period]}
              </button>
            ))}
          </div>
          {empty && <p className="economia-card-panel__note">Nenhuma compra neste período.</p>}
          <span className="economia-card-panel__label">O que entra no cartão</span>
          <label>
            <input
              type="checkbox"
              checked={options.showPieces}
              onChange={(event) =>
                setOptions({ ...options, showPieces: event.target.checked, includeStores: event.target.checked && options.includeStores })
              }
            />
            Mostrar peças
          </label>
          <label>
            <input
              type="checkbox"
              checked={options.includeStores}
              disabled={!options.showPieces}
              onChange={(event) => setOptions({ ...options, includeStores: event.target.checked })}
            />
            Incluir lojas
          </label>
          <div className="economia-card-panel__buttons">
            <button type="button" className="plane-action" onClick={downloadPng} disabled={busy || empty}>
              {busy ? 'Gerando…' : 'Baixar imagem (PNG)'}
            </button>
            {shareAvailable && (
              <button type="button" className="plane-action plane-action--secondary" onClick={sharePng} disabled={busy || empty}>
                Compartilhar
              </button>
            )}
            <button type="button" className="plane-action plane-action--secondary" onClick={downloadJson}>
              Baixar JSON
            </button>
          </div>
          {notice && (
            <p role="status" className="economia-card-panel__notice">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="economia-form__error">
              {error}
            </p>
          )}
        </fieldset>
        <img
          className="economia-card-panel__preview"
          src={svgToDataUri(svg)}
          alt="Prévia do cartão de resultados"
          width={CARD_WIDTH}
          height={CARD_HEIGHT}
        />
      </div>
    </section>
  )

  if (embedded) return panel
  return createPortal(
    <div
      className="economia-card-panel__backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {panel}
    </div>,
    document.body,
  )
}
