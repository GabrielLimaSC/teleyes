/**
 * S19-04: the shareable "cartão de resultados" — aggregates JSON plus a 1080x1350 image.
 *
 * Privacy by construction: both outputs are built from an explicit whitelist of
 * numeric aggregates and the purchase's own typed name/store, picked field by field.
 * Nothing is spread or copied wholesale from the report, so a field the API may grow
 * later (a source name, a message, a link) can never reach the export. Store names are
 * opt-in (`includeStores`, off by default) and the piece names can be switched off
 * (`showPieces`).
 *
 * S22-01: the references typed by the user (`reference*` fields of the report) are
 * deliberately left out of the card: it is shareable, and a number the user typed is
 * not a price the teleyes saw. Only the teleyes estimate is exported.
 */
import type { ReportItem, SavingsReport } from '../api/purchases'
import { parseApiDate } from '../utils/dates'
import { METHODOLOGY, blackFridayLabel, formatCount, formatCurrency, formatPct, formatSigned } from '../utils/savings'

export const CARD_WIDTH = 1080
export const CARD_HEIGHT = 1350
const MAX_PIECES = 4

export type CardPeriod = 'month' | '90d' | 'all'

export const PERIOD_LABELS: Record<CardPeriod, string> = {
  month: 'Este mês',
  '90d': '90 dias',
  all: 'Tudo',
}

export interface CardOptions {
  /** S25-F5: which purchases the card covers (by purchase date). */
  period?: CardPeriod
  /** Show the name of each piece. Off: only totals leave the app. */
  showPieces: boolean
  /** Add the store typed on each purchase. Off by default. */
  includeStores: boolean
}

export const DEFAULT_CARD_OPTIONS: CardOptions = { period: 'all', showPieces: true, includeStores: false }

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
  period: CardPeriod
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
  goal?: { amount_cents: number; deadline: string; pct: number; pace: string }
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

const PERIOD_DAYS = 90

/**
 * S25-F5: the report restricted to the purchases of `period`, totals recomputed from
 * the items exactly like the backend does (`savings.totals`): only purchases whose
 * status is `ok` add to the saving; a purchase without history adds to what was paid
 * but never to the saving. The user's own references stay out (see the file comment).
 * The period is relative to `report.generated_at`.
 */
export function filterReportByPeriod(report: SavingsReport, period: CardPeriod): SavingsReport {
  if (period === 'all') return report
  const now = parseApiDate(report.generated_at)
  const items = report.items.filter((item) => {
    const when = parseApiDate(item.purchased_at)
    if (period === 'month') {
      return when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth()
    }
    return when.getTime() >= now.getTime() - PERIOD_DAYS * 86_400_000
  })
  let saving = 0
  let reference = 0
  let counted = 0
  for (const item of items) {
    const s = item.savings
    if (s === null || s.status !== 'ok' || s.median_90d_cents === null || s.saving_vs_median_cents === null) continue
    saving += s.saving_vs_median_cents
    reference += s.median_90d_cents
    counted += 1
  }
  const gaps = items.map((item) => item.days_before_black_friday).filter((gap) => gap >= 0)
  const goal = report.goal
    ? {
        ...report.goal,
        saved_cents: saving,
        pct: report.goal.amount_cents > 0 ? Math.round((saving / report.goal.amount_cents) * 1000) / 10 : 0,
      }
    : report.goal
  return {
    ...report,
    items,
    goal,
    totals: {
      ...report.totals,
      purchases: items.length,
      linked_with_data: counted,
      total_paid_cents: items.reduce((sum, item) => sum + item.price_cents, 0),
      estimated_saving_cents: saving,
      reference_total_cents: reference,
      estimated_saving_pct: counted > 0 && reference > 0 ? Math.round((saving / reference) * 1000) / 10 : null,
    },
    black_friday: {
      ...report.black_friday,
      purchases_before: gaps.length,
      days_before_min: gaps.length > 0 ? Math.min(...gaps) : null,
      days_before_max: gaps.length > 0 ? Math.max(...gaps) : null,
    },
  }
}

/** The JSON of aggregates: whitelist only (see the file comment). */
export function buildResultsAggregates(fullReport: SavingsReport, options: CardOptions): ResultsAggregates {
  const report = filterReportByPeriod(fullReport, options.period ?? 'all')
  const { totals, black_friday: bf, noise } = report
  const discarded = {
    sem_termo: noise.discarded.sem_termo,
    bloqueado: noise.discarded.bloqueado,
    preco_acima_teto: noise.discarded.preco_acima_teto,
  }
  const aggregates: ResultsAggregates = {
    schema: 'teleyes.results/1',
    generated_at: report.generated_at,
    period: options.period ?? 'all',
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
  if (report.goal) {
    aggregates.goal = {
      amount_cents: report.goal.amount_cents,
      deadline: report.goal.deadline,
      pct: report.goal.pct,
      pace: report.goal.pace,
    }
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

/** Average glyph width as a fraction of the font size; deliberately on the wide side. */
const GLYPH_WIDTH = 0.6
const GLYPH_WIDTH_BOLD = 0.64

/** Conservative width of a line of text, so layout never depends on measuring fonts. */
export function estimateTextWidth(content: string, size: number, bold = false): number {
  return content.length * size * (bold ? GLYPH_WIDTH_BOLD : GLYPH_WIDTH)
}

/** The largest font size (down to `min`) at which `content` fits in `maxWidth`. */
function fitSize(content: string, maxSize: number, maxWidth: number, bold = false, min = 16): number {
  const fitted = Math.floor(maxWidth / (content.length * (bold ? GLYPH_WIDTH_BOLD : GLYPH_WIDTH)))
  return Math.max(min, Math.min(maxSize, fitted))
}

function truncateToWidth(content: string, size: number, maxWidth: number, bold = false): string {
  const maxChars = Math.max(4, Math.floor(maxWidth / (size * (bold ? GLYPH_WIDTH_BOLD : GLYPH_WIDTH))))
  return content.length <= maxChars ? content : `${content.slice(0, maxChars - 1).trimEnd()}…`
}

function bfText(bf: ResultsAggregates['black_friday']): string {
  const { days_before_min: min, days_before_max: max } = bf
  if (min === null || max === null) return '—'
  if (min === max) return blackFridayLabel(min)
  return `${min}–${max} dias antes`
}

function goalText(goal: NonNullable<ResultsAggregates['goal']>): string {
  const shown = Math.round(Math.min(100, Math.max(0, goal.pct)))
  return `${shown}% de ${formatCurrency(goal.amount_cents)}`
}

function text(x: number, y: number, content: string, size: number, fill: string, extra = ''): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${escapeXml(content)}</text>`
}

const FOOTER_NOTE = 'Estimativa com base nos preços que o teleyes viu — não é garantia de mercado.'
const MARGIN = 60
const INNER = CARD_WIDTH - 2 * MARGIN // 960
const PIECE_ROW = 72
const STAT_WIDTH = 300
const STAT_GAP = (INNER - 3 * STAT_WIDTH) / 2

function stat(x: number, y: number, label: string, value: string, palette: CardPalette): string {
  const innerWidth = STAT_WIDTH - 56
  return [
    `<rect x="${x}" y="${y}" width="${STAT_WIDTH}" height="150" rx="28" fill="${palette.surface}" stroke="${palette.border}" stroke-width="2"/>`,
    text(x + 28, y + 50, label, 26, palette.muted),
    text(x + 28, y + 116, value, fitSize(value, 52, innerWidth, true, 22), palette.text, 'font-weight="700"'),
  ].join('')
}

function pieceRow(piece: ResultsPiece, y: number, palette: CardPalette): string {
  const label = piece.store === undefined ? piece.name : `${piece.name} · ${piece.store}`
  const gain = piece.saving_vs_median_cents
  const paidText = formatCurrency(piece.paid_cents)
  const gainText =
    gain === null
      ? 'sem histórico'
      : `${formatSigned(gain)}${piece.saving_vs_median_pct === null ? '' : ` · ${formatPct(Math.abs(piece.saving_vs_median_pct))}`}`
  // The numbers column is as wide as the longest number; the name gets what is left.
  const numbersWidth = Math.min(
    560,
    Math.max(estimateTextWidth(paidText, 28, true), estimateTextWidth(gainText, 22, true)),
  )
  const nameWidth = INNER - numbersWidth - 32
  const right = CARD_WIDTH - MARGIN
  return [
    `<line x1="${MARGIN}" y1="${y}" x2="${right}" y2="${y}" stroke="${palette.border}" stroke-width="2"/>`,
    text(MARGIN, y + 46, truncateToWidth(label, 30, nameWidth, true), 30, palette.text, 'font-weight="600"'),
    text(right, y + 36, paidText, 28, palette.text, 'font-weight="700" text-anchor="end"'),
    text(
      right,
      y + 62,
      gainText,
      22,
      gain === null ? palette.muted : gain < 0 ? palette.bad : palette.good,
      'font-weight="600" text-anchor="end"',
    ),
  ].join('')
}

/**
 * 1080x1350 SVG, laid out as a vertical flow: every block starts below the end of the
 * previous one, and every number is sized from the widest value it has to hold, so
 * long amounts shrink instead of colliding. `mascotDataUri` is optional: without it
 * the card shows a plain dot.
 */
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
  const heroValue = hasSaving ? formatSigned(saving) : 'sem dados'
  const heroInner = INNER - 80
  const heroLines = hasSaving
    ? [
        totals.estimated_saving_pct === null
          ? 'comparado à mediana dos 90 dias anteriores'
          : `${formatPct(Math.abs(totals.estimated_saving_pct))} ${saving < 0 ? 'acima' : 'abaixo'} da mediana dos 90 dias`,
        `${totals.pieces_with_data} de ${totals.purchases} ${totals.purchases === 1 ? 'compra' : 'compras'} com histórico`,
      ]
    : ['ainda sem histórico suficiente para estimar']

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">`,
    `<defs><radialGradient id="glow" cx="50%" cy="0%" r="70%"><stop offset="0%" stop-color="${palette.glow}" stop-opacity="0.55"/><stop offset="100%" stop-color="${palette.glow}" stop-opacity="0"/></radialGradient></defs>`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${palette.background}"/>`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow)"/>`,
  ]

  // Header: mascot + wordmark (y 50-170).
  if (mascotDataUri !== null) {
    parts.push(
      `<clipPath id="mascot-clip"><circle cx="112" cy="110" r="52"/></clipPath>`,
      `<circle cx="112" cy="110" r="56" fill="${palette.surface}" stroke="${palette.border}" stroke-width="2"/>`,
      `<image href="${mascotDataUri}" x="60" y="58" width="104" height="104" clip-path="url(#mascot-clip)" preserveAspectRatio="xMidYMid slice"/>`,
    )
  } else {
    parts.push(`<circle cx="112" cy="110" r="40" fill="${palette.accent}"/>`)
  }
  parts.push(
    text(190, 106, 'teleyes', 46, palette.text, 'font-weight="700"'),
    text(190, 148, `Relatório de economia · ${PERIOD_LABELS[aggregates.period]}`, 28, palette.muted),
  )

  // Hero (y 200-490).
  parts.push(
    `<rect x="${MARGIN}" y="200" width="${INNER}" height="290" rx="36" fill="${palette.surface}" stroke="${palette.border}" stroke-width="2"/>`,
    text(100, 262, heroLabel, 26, palette.muted, 'letter-spacing="3"'),
    text(
      100,
      380,
      heroValue,
      fitSize(heroValue, hasSaving ? 128 : 96, heroInner, true, 40),
      hasSaving ? tone : palette.muted,
      'font-weight="800"',
    ),
  )
  heroLines.forEach((line, index) => {
    parts.push(text(100, 430 + index * 34, line, fitSize(line, 26, heroInner, false, 18), palette.muted))
  })

  // Stats (y 520-670).
  const statY = 520
  parts.push(
    stat(MARGIN, statY, 'Total pago', formatCurrency(totals.total_paid_cents), palette),
    stat(MARGIN + STAT_WIDTH + STAT_GAP, statY, 'Compras', String(totals.purchases), palette),
    aggregates.goal
      ? stat(MARGIN + 2 * (STAT_WIDTH + STAT_GAP), statY, 'Meta', goalText(aggregates.goal), palette)
      : stat(MARGIN + 2 * (STAT_WIDTH + STAT_GAP), statY, 'Black Friday', bfText(aggregates.black_friday), palette),
  )

  // Pieces (optional): the list grows down from here; "sem histórico" rows are listed too.
  let cursor = 690
  if (aggregates.pieces !== undefined && aggregates.pieces.length > 0) {
    cursor += 40
    parts.push(text(MARGIN, cursor, 'PEÇAS', 24, palette.muted, 'letter-spacing="3"'))
    cursor += 20
    const shown = aggregates.pieces.slice(0, MAX_PIECES)
    shown.forEach((piece) => {
      parts.push(pieceRow(piece, cursor, palette))
      cursor += PIECE_ROW
    })
    const hidden = aggregates.pieces.length - shown.length
    if (hidden > 0) {
      parts.push(text(MARGIN, cursor + 30, `+ ${hidden} ${hidden === 1 ? 'peça' : 'peças'}`, 24, palette.muted))
      cursor += 44
    }
  }

  // Noise avoided: starts below whatever came before.
  const noiseY = cursor + 28
  const column = INNER / 3
  const noiseItems: Array<[string, string]> = [
    [formatCount(noise.messages_analyzed), 'mensagens analisadas'],
    [formatCount(noise.discarded_total), 'descartadas'],
    [formatCount(noise.duplicates_grouped), 'repetidos agrupados'],
  ]
  parts.push(
    `<rect x="${MARGIN}" y="${noiseY}" width="${INNER}" height="140" rx="28" fill="${palette.surface}" stroke="${palette.border}" stroke-width="2"/>`,
    text(92, noiseY + 38, 'RUÍDO EVITADO', 22, palette.muted, 'letter-spacing="3"'),
  )
  noiseItems.forEach(([value, caption], index) => {
    const x = 92 + index * column
    parts.push(
      text(x, noiseY + 92, value, fitSize(value, 44, column - 40, true, 24), palette.text, 'font-weight="700"'),
      text(x, noiseY + 120, caption, fitSize(caption, 20, column - 40, false, 16), palette.muted),
    )
  })

  // Footer: pinned to the bottom edge.
  parts.push(
    text(MARGIN, 1286, FOOTER_NOTE, fitSize(FOOTER_NOTE, 21, INNER), palette.muted),
    text(MARGIN, 1320, 'teleyes · monitor pessoal de promoções', 20, palette.accent),
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
    if (!response.ok || !(response.headers.get('content-type') ?? '').startsWith('image/')) return null
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

/** The PNG as a `File`, ready for `navigator.share` or the clipboard. */
export function pngFile(blob: Blob): File {
  return new File([blob], 'teleyes-economia.png', { type: 'image/png' })
}

export type ShareOutcome = 'shared' | 'copied' | 'cancelled'

/** Whether some way of sharing the image exists here (share sheet or clipboard). */
export function canShareImage(): boolean {
  if (typeof navigator === 'undefined') return false
  if (typeof navigator.share === 'function' && typeof navigator.canShare === 'function') return true
  return typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined'
}

/**
 * S25-F5: share the card image. `navigator.share` with the file when the browser
 * accepts it; otherwise the image goes to the clipboard ("copied"). Throws when
 * neither works, so the caller can say so.
 */
export async function shareImage(blob: Blob): Promise<ShareOutcome> {
  const file = pngFile(blob)
  if (typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Meus resultados no teleyes' })
      return 'shared'
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return 'cancelled'
      // Any other failure: fall through to the clipboard.
    }
  }
  if (typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return 'copied'
  }
  throw new Error('Não foi possível compartilhar a imagem.')
}
