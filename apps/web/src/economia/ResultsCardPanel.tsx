import { useEffect, useMemo, useState } from 'react'
import type { SavingsReport } from '../api/purchases'
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  DEFAULT_CARD_OPTIONS,
  buildResultsAggregates,
  buildResultsSvg,
  loadMascotDataUri,
  readCardPalette,
  resultsJson,
  svgToDataUri,
  svgToPngBlob,
} from './resultsCard'
import type { CardOptions } from './resultsCard'

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
export function ResultsCardPanel({ report, onClose }: { report: SavingsReport; onClose: () => void }) {
  const [options, setOptions] = useState<CardOptions>(DEFAULT_CARD_OPTIONS)
  const [mascot, setMascot] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadMascotDataUri(`${import.meta.env.BASE_URL}mascot.png`).then((uri) => {
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

  return (
    <section className="plane-pearl economia-card-panel" aria-labelledby="economia-card-title">
      <div className="economia-card-panel__header">
        <h2 id="economia-card-title">Cartão de resultados</h2>
        <button type="button" className="plane-action plane-action--secondary" onClick={onClose}>
          Fechar
        </button>
      </div>
      <p className="economia-card-panel__note">
        A imagem ({CARD_WIDTH}×{CARD_HEIGHT}) e o JSON levam só números agregados: nunca nomes de grupos,
        mensagens ou links.
      </p>
      <div className="economia-card-panel__body">
        <fieldset className="economia-card-panel__options">
          <legend>O que entra no cartão</legend>
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
            <button type="button" className="plane-action" onClick={downloadPng} disabled={busy}>
              {busy ? 'Gerando…' : 'Baixar imagem (PNG)'}
            </button>
            <button type="button" className="plane-action plane-action--secondary" onClick={downloadJson}>
              Baixar JSON
            </button>
          </div>
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
}
