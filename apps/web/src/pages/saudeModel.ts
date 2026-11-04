import type { HeartbeatBucket, ServiceKey, SystemEventKind } from '../api/healthHistory'
import { parseApiDate } from '../utils/dates'

export type BarKind = 'ok' | 'partial' | 'down' | 'none'
export type Tone = 'good' | 'warn' | 'danger' | 'neutral'

/** green when every sample was healthy, amber when some were, red when none, gray when unmeasured. */
export function barKind(bucket: HeartbeatBucket | null): BarKind {
  if (bucket === null || bucket.ok === null || bucket.total === null || bucket.total <= 0) return 'none'
  if (bucket.ok >= bucket.total) return 'ok'
  if (bucket.ok <= 0) return 'down'
  return 'partial'
}

/** Pads/truncates to exactly `size` bars (oldest first); missing hours count as unmeasured. */
export function normalizeBuckets<T>(items: T[], size = 24): (T | null)[] {
  const tail = items.slice(-size)
  return [...Array<null>(size - tail.length).fill(null), ...tail]
}

/** Availability over the hours that HAVE data only; `null` when none (shown as "—"). */
export function availability(buckets: (HeartbeatBucket | null)[]): number | null {
  let ok = 0
  let total = 0
  for (const bucket of buckets) {
    if (bucket === null || barKind(bucket) === 'none') continue
    ok += bucket.ok ?? 0
    total += bucket.total ?? 0
  }
  return total === 0 ? null : (ok / total) * 100
}

/** "98,6%", "100%", "—". Truncates (never rounds up to 100% while a sample failed). */
export function formatAvailability(percent: number | null): string {
  if (percent === null) return '—'
  const floored = Math.floor(percent * 10 + 1e-9) / 10
  return `${floored.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}

export function hourLabel(iso: string): string {
  return parseApiDate(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

export function barTooltip(bucket: HeartbeatBucket | null): string {
  if (bucket === null) return 'coletando'
  const prefix = `${hourLabel(bucket.hour)} · `
  if (barKind(bucket) === 'none') return `${prefix}coletando`
  return `${prefix}${bucket.ok}/${bucket.total} verificações ok`
}

export interface ServiceView {
  key: ServiceKey
  name: string
  pill: string
  tone: Tone
}

export const SERVICE_ORDER: { key: ServiceKey; name: string }[] = [
  { key: 'telegram', name: 'Telegram' },
  { key: 'bot', name: 'Bot' },
  { key: 'listener', name: 'Leitor do Telegram' },
  { key: 'sse', name: 'Atualização ao vivo' },
  { key: 'db', name: 'Banco' },
]

export interface Verdict {
  tone: Tone
  title: string
  detail: string
  active: number
  total: number
}

/** Services still loading (no view yet) are simply not counted as active. */
export function buildVerdict(views: ServiceView[], demo: boolean): Verdict {
  const total = SERVICE_ORDER.length
  const active = views.filter((view) => view.tone === 'good').length
  const base = `${active} de ${total} serviços ativos`
  const down = views.find((view) => view.tone === 'danger')
  if (down) {
    return { tone: 'danger', title: `Atenção: ${down.name} fora`, detail: `${base}.`, active, total }
  }
  const unstable = views.find((view) => view.tone === 'warn')
  if (unstable) {
    return { tone: 'warn', title: `Atenção: ${unstable.name} instável`, detail: `${base}.`, active, total }
  }
  const off = views.filter((view) => view.tone === 'neutral')
  if (off.length > 0) {
    const names = off.map((view) => view.name).join(' e ')
    const verb = off.length > 1 ? 'estão desligados' : 'está desligado'
    if (demo) {
      return {
        tone: 'warn',
        title: 'Operando em demonstração',
        detail: `${base}. ${names} ${verb} de propósito — nenhum alerta sai.`,
        active,
        total,
      }
    }
    return { tone: 'warn', title: 'Configuração incompleta', detail: `${base}. ${names} ${verb}.`, active, total }
  }
  if (active < total) {
    return { tone: 'neutral', title: 'Verificando serviços…', detail: `${base}.`, active, total }
  }
  return { tone: 'good', title: 'Tudo funcionando', detail: `${base}.`, active, total }
}

export const EVENT_KIND: Record<SystemEventKind, { label: string; tone: Tone }> = {
  match_target: { label: 'oferta', tone: 'good' },
  sse_reconnect: { label: 'sse', tone: 'warn' },
  rules_applied: { label: 'regras', tone: 'neutral' },
  backup: { label: 'banco', tone: 'neutral' },
  test_send: { label: 'envio', tone: 'neutral' },
  listener_reconnect: { label: 'telegram', tone: 'warn' },
  delivery_failure: { label: 'falha', tone: 'danger' },
}

/** "coletando desde 14:00" only while coverage began inside the window (it is not full yet). */
export function coverageNote(coverageSince: string | null, hours = 24, now: Date = new Date()): string | null {
  if (coverageSince === null) return null
  const since = parseApiDate(coverageSince)
  if (now.getTime() - since.getTime() >= hours * 3600_000) return null
  return `coletando desde ${hourLabel(coverageSince)}`
}

export function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (hours > 0) return `${hours}h ${minutes}min`
  if (minutes > 0) return `${minutes}min ${secs}s`
  return `${secs}s`
}
