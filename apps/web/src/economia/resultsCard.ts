/**
 * S19-04: the shareable "cartão de resultados" — aggregates JSON plus a 1080x1350 image.
 *
 * Privacy by construction: both outputs are built from an explicit whitelist of
 * numeric aggregates and the purchase's own typed name/store, picked field by field.
 * Nothing is spread or copied wholesale from the report, so a field the API may grow
 * later (a source name, a message, a link) can never reach the export. Store names are
 * opt-in (`includeStores`, off by default) and the piece names can be switched off
 * (`showPieces`).
 */
import type { ReportItem, SavingsReport } from '../api/purchases'
import { METHODOLOGY, blackFridayLabel, formatCount, formatCurrency, formatPct, formatSigned } from '../utils/savings'

export const CARD_WIDTH = 1080
export const CARD_HEIGHT = 1350
const MAX_PIECES = 5

export interface CardOptions {
  /** Show the name of each piece. Off: only totals leave the app. */
  showPieces: boolean
  /** Add the store typed on each purchase. Off by default. */
  includeStores: boolean
}

export const DEFAULT_CARD_OPTIONS: CardOptions = { showPieces: true, includeStores: false }

export interface ResultsPiece {
  name: string
  paid_cents: number
  saving_vs_median_cents: number | null
  saving_vs_median_pct: number | null
  store?: string
}

export interface ResultsAggregates {
  schema: 'teleyes.results/1'
  generated_at: string
  methodology: string
  totals: {
    purchases: number
    pieces_with_data: number
    total_paid_cents: number
    estimated_saving_cents: number
    estimated_saving_pct: number | null
  }
  black_friday: {
    date: string
    purchases_before: number
    days_before_min: number | null
    days_before_max: number | null
  }
  noise: {
    messages_analyzed: number
    discarded_total: number
    discarded: { sem_termo: number; bloqueado: number; preco_acima_teto: number }
    duplicates_grouped: number
    alerts_matched: number
    alerts_sent: number
  }
  pieces?: ResultsPiece[]
}

function pieceOf(item: ReportItem, includeStores: boolean): ResultsPiece {
  const ok = item.savings !== null && item.savings.status === 'ok'
  const piece: ResultsPiece = {
    name: item.name,
    paid_cents: item.price_cents,
    saving_vs_median_cents: ok ? (item.savings?.saving_vs_median_cents ?? null) : null,
    saving_vs_median_pct: ok ? (item.savings?.saving_vs_median_pct ?? null) : null,
  }
  if (includeStores && item.store !== null) piece.store = item.store
  return piece
}

/** The JSON of aggregates: whitelist only (see the file comment). */
export function buildResultsAggregates(report: SavingsReport, options: CardOptions): ResultsAggregates {
  const { totals, black_friday: bf, noise } = report
  const discarded = {
    sem_termo: noise.discarded.sem_termo,
    bloqueado: noise.discarded.bloqueado,
    preco_acima_teto: noise.discarded.preco_acima_teto,
  }
  const aggregates: ResultsAggregates = {
    schema: 'teleyes.results/1',
    generated_at: report.generated_at,
    methodology: METHODOLOGY,
    totals: {
      purchases: totals.purchases,
      pieces_with_data: totals.linked_with_data,
      total_paid_cents: totals.total_paid_cents,
      estimated_saving_cents: totals.estimated_saving_cents,
      estimated_saving_pct: totals.estimated_saving_pct,
    },
    black_friday: {
      date: bf.date,
      purchases_before: bf.purchases_before,
      days_before_min: bf.days_before_min,
      days_before_max: bf.days_before_max,
    },
    noise: {
      messages_analyzed: noise.messages_analyzed,
      discarded_total: discarded.sem_termo + discarded.bloqueado + discarded.preco_acima_teto,
      discarded,
      duplicates_grouped: noise.duplicates_grouped,
      alerts_matched: noise.alerts_matched,
      alerts_sent: noise.alerts_sent,
    },
  }
  if (options.showPieces) {
    aggregates.pieces = report.items.map((item) => pieceOf(item, options.includeStores))
  }
  return aggregates
}

/** Colors come from `--results-card-*` tokens (styles/materials.css): the image is
 * shared outside the app, so it is always the dark look, whatever theme is active. */
export interface CardPalette {
  background: string
  glow: string
  surface: string
  border: string
  text: string
  muted: string
  good: string
  bad: string
  accent: string
}

const PALETTE_TOKENS: Record<keyof CardPalette, string> = {
  background: '--results-card-bg',
  glow: '--results-card-glow',
  surface: '--results-card-surface',
  border: '--results-card-border',
  text: '--results-card-text',
  muted: '--results-card-muted',
  good: '--results-card-good',
  bad: '--results-card-bad',
  accent: '--results-card-accent',
}

export function readCardPalette(root: Element = document.documentElement): CardPalette {
  const styles = getComputedStyle(root)
  const read = (token: string) => styles.getPropertyValue(token).trim() || 'currentColor'
  return Object.fromEntries(
    Object.entries(PALETTE_TOKENS).map(([key, token]) => [key, read(token)]),
  ) as unknown as CardPalette
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

function bfText(bf: ResultsAggregates['black_friday']): string {
  const { days_before_min: min, days_before_max: max } = bf
  if (min === null || max === null) return '—'
  if (min === max) return blackFridayLabel(min)
  return `${min}–${max} dias antes`
}

function text(
  x: number,
  y: number,
  content: string,
  size: number,
  fill: string,
  extra = '',
): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${escapeXml(content)}</text>`
}

function stat(x: number, label: string, value: string, palette: CardPalette): string {
  const width = 300
  return [
    `<rect x="${x}" y="566" width="${width}" height="170" rx="28" fill="${palette.surface}" stroke="${palette.border}" stroke-width="2"/>`,
    text(x + 28, 618, label, 26, palette.muted),
    text(x + 28, 690, value, value.length > 12 ? 40 : 52, palette.text, 'font-weight="700"'),
  ].join('')
}

/** 1080x1350 SVG. `mascotDataUri` is optional: without it the card shows a plain dot. */
export function buildResultsSvg(
  aggregates: ResultsAggregates,
  palette: CardPalette,
  mascotDataUri: string | null = null,
): string {
  const { totals, noise } = aggregates
  const hasSaving = totals.pieces_with_data > 0
  const saving = totals.estimated_saving_cents
  const tone = saving < 0 ? palette.bad : palette.good
  const heroLabel = hasSaving && saving < 0 ? 'PAGO ACIMA DA MEDIANA' : 'ECONOMIA ESTIMADA'
  const heroValue = hasSaving ? formatSigned(saving).replace('+', '') : 'sem dados'
  const heroSub = hasSaving
    ? `${totals.estimated_saving_pct === null ? '' : `${formatPct(totals.estimated_saving_pct)} vs. a mediana dos 90 dias · `}${totals.pieces_with_data} de ${totals.purchases} ${totals.purchases === 1 ? 'compra' : 'compras'} com histórico`
    : 'ainda sem histórico suficiente para estimar'

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">`,
    `<defs><radialGradient id="glow" cx="50%" cy="0%" r="70%"><stop offset="0%" stop-color="${palette.glow}" stop-opacity="0.55"/><stop offset="100%" stop-color="${palette.glow}" stop-opacity="0"/></radialGradient></defs>`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${palette.background}"/>`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow)"/>`,
  ]

  // Header: mascot + wordmark.
  if (mascotDataUri !== null) {
    parts.push(
      `<clipPath id="mascot-clip"><circle cx="112" cy="112" r="52"/></clipPath>`,
      `<circle cx="112" cy="112" r="56" fill="${palette.surface}" stroke="${palette.border}" stroke-width="2"/>`,
      `<image href="${mascotDataUri}" x="60" y="60" width="104" height="104" clip-path="url(#mascot-clip)"/>`,
    )
  } else {
    parts.push(`<circle cx="112" cy="112" r="40" fill="${palette.accent}"/>`)
  }
  parts.push(
    text(190, 108, 'teleyes', 46, palette.text, 'font-weight="700"'),
    text(190, 150, 'Relatório de economia', 28, palette.muted),
  )

  // Hero.
  parts.push(
    `<rect x="60" y="230" width="960" height="300" rx="36" fill="${palette.surface}" stroke="${palette.border}" stroke-width="2"/>`,
    text(100, 296, heroLabel, 26, palette.muted, 'letter-spacing="3"'),
    text(100, 424, heroValue, hasSaving ? 128 : 96, hasSaving ? tone : palette.muted, 'font-weight="800"'),
    text(100, 488, heroSub, 26, palette.muted),
  )

  // Stats.
  parts.push(
    stat(60, 'Total pago', formatCurrency(totals.total_paid_cents), palette),
    stat(390, 'Compras', String(totals.purchases), palette),
    stat(720, 'Black Friday', bfText(aggregates.black_friday), palette),
  )

  // Pieces (optional).
  let cursor = 800
  if (aggregates.pieces !== undefined && aggregates.pieces.length > 0) {
    parts.push(text(60, cursor, 'Peças', 26, palette.muted, 'letter-spacing="3"'))
    cursor += 20
    const shown = aggregates.pieces.slice(0, MAX_PIECES)
    shown.forEach((piece, index) => {
      const y = cursor + index * 76
      const label = piece.store === undefined ? piece.name : `${piece.name} · ${piece.store}`
      const gain = piece.saving_vs_median_cents
      const gainText =
        gain === null
          ? 'sem dados'
          : `${formatSigned(gain)}${piece.saving_vs_median_pct === null ? '' : ` (${formatPct(piece.saving_vs_median_pct)})`}`
      parts.push(
        `<line x1="60" y1="${y + 12}" x2="1020" y2="${y + 12}" stroke="${palette.border}" stroke-width="2"/>`,
        text(60, y + 54, truncate(label, 30), 30, palette.text, 'font-weight="600"'),
        text(1020, y + 38, formatCurrency(piece.paid_cents), 28, palette.text, 'text-anchor="end"'),
        text(
          1020,
          y + 68,
          gainText,
          22,
          gain === null ? palette.muted : gain < 0 ? palette.bad : palette.good,
          'text-anchor="end"',
        ),
      )
    })
    const hidden = aggregates.pieces.length - shown.length
    if (hidden > 0) {
      parts.push(text(60, cursor + shown.length * 76 + 44, `+ ${hidden} ${hidden === 1 ? 'peça' : 'peças'}`, 24, palette.muted))
    }
  }

  // Noise avoided.
  parts.push(
    `<rect x="60" y="1100" width="960" height="150" rx="28" fill="${palette.surface}" stroke="${palette.border}" stroke-width="2"/>`,
    text(92, 1148, 'RUÍDO EVITADO', 22, palette.muted, 'letter-spacing="3"'),
    text(92, 1210, `${formatCount(noise.messages_analyzed)}`, 46, palette.text, 'font-weight="700"'),
    text(92, 1238, 'mensagens analisadas', 20, palette.muted),
    text(420, 1210, `${formatCount(noise.discarded_total)}`, 46, palette.text, 'font-weight="700"'),
    text(420, 1238, 'descartadas', 20, palette.muted),
    text(720, 1210, `${formatCount(noise.duplicates_grouped)}`, 46, palette.text, 'font-weight="700"'),
    text(720, 1238, 'repetidos agrupados', 20, palette.muted),
  )

  // Footer.
  parts.push(
    text(60, 1296, 'Estimativa com base nos preços que o próprio teleyes viu — não é garantia de mercado.', 21, palette.muted),
    text(60, 1326, 'teleyes · monitor pessoal de promoções', 20, palette.accent),
    '</svg>',
  )
  return parts.join('')
}

export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export function resultsJson(aggregates: ResultsAggregates): string {
  return `${JSON.stringify(aggregates, null, 2)}\n`
}

/** Rasterises the SVG in the browser (canvas); resolves with a PNG blob. */
export function svgToPngBlob(svg: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = CARD_WIDTH
      canvas.height = CARD_HEIGHT
      const context = canvas.getContext('2d')
      if (context === null) {
        reject(new Error('Canvas indisponível neste navegador.'))
        return
      }
      context.drawImage(image, 0, 0, CARD_WIDTH, CARD_HEIGHT)
      canvas.toBlob((blob) => {
        if (blob === null) reject(new Error('Não foi possível gerar a imagem.'))
        else resolve(blob)
      }, 'image/png')
    }
    image.onerror = () => reject(new Error('Não foi possível renderizar o cartão.'))
    image.src = svgToDataUri(svg)
  })
}

/** The mascot as a data URI, so it survives inside the exported image; `null` on any failure. */
export async function loadMascotDataUri(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}
