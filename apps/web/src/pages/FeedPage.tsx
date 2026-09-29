import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MatchCard } from '../components/MatchCard'
import { ProductPanel } from '../components/ProductPanel'
import { Toast } from '../components/Toast'
import { RailChevron, RailStrip } from '../components/RailStrip'
import type { RailStripItem } from '../components/RailStrip'
import {
  anchorScrollDuring,
  CHROME_SPRING_MS,
  markChromeAnimating,
  onBeforeChromeChange,
  registerChromeFlip,
  useScrollChrome,
} from '../chrome/scrollChrome'
import { fetchRecipients, fetchRules, fetchSources } from '../api/lookups'
import { useLiveMatches } from '../hooks/useLiveMatches'
import type { FeedConnectionState } from '../hooks/useLiveMatches'
import { useProductPanel } from '../hooks/useProductPanel'
import { useToast } from '../hooks/useToast'
import { useAuth, CSRF_MISSING_MESSAGE } from '../auth/AuthContext'
import { ApiError } from '../api/auth'
import { listSnoozes, reactivateSnooze, snoozeProduct } from '../api/snoozes'
import { fetchDigestSettings, updateDigestSettings } from '../api/digest'
import { fetchFeedSettings, updateFeedSettings } from '../api/feedSettings'
import { updateRule } from '../api/rules'
import { targetGapPct, targetHit } from '../utils/target'
import { latestMatchForProduct } from '../utils/productMatch'
import { isSameLocalDay, parseApiDate } from '../utils/dates'
import type { DigestSettings, FeedSettings, Match, Recipient, Rule, Snooze, Source } from '../api/types'
import '../styles/materials.css'
import '../styles/productPanelLayout.css'
import '../components/FillButton.css'
import './FeedPage.css'

const CONNECTION_LABELS: Record<FeedConnectionState, { label: string; color: string; dot: string }> = {
  connecting: { label: 'SSE conectando…', color: 'var(--plane-status-warn)', dot: 'var(--plane-status-warn-dot)' },
  open: { label: 'SSE conectado', color: 'var(--plane-status-good)', dot: 'var(--plane-status-good-dot)' },
  error: {
    label: 'SSE caiu — tentando reconectar…',
    color: 'var(--plane-status-danger)',
    dot: 'var(--plane-status-danger-dot)',
  },
}

const TOP_N_OPTIONS = [3, 5, 10, 20]

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/** S14-07: "6d restantes" / "expira hoje" — a plain day count from `until`,
 * never a made-up freshness window. */
function formatSnoozeRemaining(until: string, now: Date): string {
  const diffMs = parseApiDate(until).getTime() - now.getTime()
  const days = Math.ceil(diffMs / 86_400_000)
  if (days <= 0) return 'expira hoje'
  return days === 1 ? '1 dia restante' : `${days} dias restantes`
}

interface TargetRuleRow {
  rule: Rule
  /** Most recent day's price from `rule.history_30d` (its last point, the
   * array is oldest first) — `null` with no priced match in the last 30
   * days. Never `rule.lowest_price_cents` (S7-06's all-time minimum), which
   * would keep showing "atingido" long after the price went back up. */
  latestPriceCents: number | null
  hit: boolean
  gapPct: number | null
  progressPct: number
}

/** A callback whose identity never changes but always runs the latest
 * closure — lets the memoized card list below skip re-renders that only the
 * page's own chrome state caused. */
function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const ref = useRef(callback)
  useLayoutEffect(() => {
    ref.current = callback
  })
  return useCallback((...args: Args) => ref.current(...args), [])
}

/** S15-03: the cards, memoized — scrolling in and out of the compact chrome
 * re-renders FeedPage (rail state, chrome mode) and a long feed's cards made
 * that frame visibly long; they only depend on the data below. */
const FeedMatchList = memo(function FeedMatchList({
  visibleMatches,
  hasAnyMatch,
  rules,
  sources,
  recipients,
  onOpenProduct,
  onCreateRule,
  onSnooze,
  onSetTarget,
}: {
  visibleMatches: Match[]
  hasAnyMatch: boolean
  rules: Rule[]
  sources: Source[]
  recipients: Recipient[]
  onOpenProduct: (key: string, trigger: HTMLElement | null) => void
  onCreateRule: (productKey: string) => void
  onSnooze: (match: Match) => void
  onSetTarget: (ruleId: number, targetCents: number) => void
}) {
  return (
    <div className="feed-page__list">
      {visibleMatches.length === 0 && !hasAnyMatch && <p>Nenhum match ainda.</p>}
      {visibleMatches.length === 0 && hasAnyMatch && <p>Nenhum match para esta regra ainda.</p>}
      {visibleMatches.map((match) => (
        <div key={match.id} className="feed-page__card">
          <MatchCard
            match={match}
            rule={rules.find((rule) => rule.id === match.rule_id)}
            source={sources.find((source) => source.id === match.source_id)}
            recipients={recipients}
            isLowestPriceEver={match.is_lowest_price_ever}
            groupedSourceNames={match.grouped_source_ids
              ?.map((sourceId) => sources.find((source) => source.id === sourceId)?.name)
              .filter((name): name is string => Boolean(name))}
            onOpenProduct={onOpenProduct}
            onCreateRule={onCreateRule}
            onSnooze={onSnooze}
            onSetTarget={onSetTarget}
          />
        </div>
      ))}
    </div>
  )
})

export function FeedPage() {
  const { matches, loading, error, connectionState, refresh } = useLiveMatches()
  const panel = useProductPanel()
  const navigate = useNavigate()
  const { csrfToken } = useAuth()
  const { toast, showToast, dismiss } = useToast()

  const [rules, setRules] = useState<Rule[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [selectedRuleId, setSelectedRuleId] = useState<number | null>(null)
  const [snoozes, setSnoozes] = useState<Snooze[]>([])
  const [digest, setDigest] = useState<DigestSettings | null>(null)
  const [feedSettings, setFeedSettings] = useState<FeedSettings | null>(null)

  const loadRules = () => fetchRules().then(setRules).catch(() => setRules([]))
  const loadSnoozes = () => listSnoozes().then(setSnoozes).catch(() => setSnoozes([]))
  const loadDigest = () => fetchDigestSettings().then(setDigest).catch(() => setDigest(null))
  const loadFeedSettings = () => fetchFeedSettings().then(setFeedSettings).catch(() => setFeedSettings(null))

  useEffect(() => {
    loadRules()
    fetchSources().then(setSources).catch(() => setSources([]))
    fetchRecipients().then(setRecipients).catch(() => setRecipients([]))
    loadSnoozes()
    loadDigest()
    loadFeedSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // S14-07 revisão 1 (bloqueio 2): `rules` carries each rule's own
  // `history_30d`/`snoozed_until` (the sidebar's "Alvos de preço" and
  // "Filtrar por regra" source) — `useLiveMatches` already reloads `matches`
  // on every SSE `match`/`resync` event (or "Atualizar"), but never touched
  // `rules`, so a brand-new match's rule kept showing yesterday's history
  // until something unrelated (like saving a target) happened to reload it.
  // Reloading here too, keyed on `matches` itself, keeps both in step.
  useEffect(() => {
    loadRules()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches])

  function reportError(err: unknown, fallback: string) {
    showToast(err instanceof ApiError ? err.message : fallback, 'error')
  }

  function requireCsrf(): string | null {
    if (csrfToken === null) {
      showToast(CSRF_MISSING_MESSAGE, 'error')
      return null
    }
    return csrfToken
  }

  // S14-07: "Criar regra disso" — navigates to Regras v2's own URL contract
  // (`/regras?produto=<key>`, another Dev's task); this page owns nothing
  // past the navigation itself.
  function handleCreateRule(productKey: string) {
    navigate(`/regras?produto=${encodeURIComponent(productKey)}`)
  }

  // S14-07: "Silenciar 7 dias" / "Reativar" from the card — always scope
  // 'product' (the card always has a `product_key` when this is wired up).
  // Reactivating needs the snooze's own id, which `Match` doesn't carry —
  // looked up from the sidebar's own `snoozes` list instead of a second
  // endpoint.
  async function handleCardSnooze(match: Match) {
    const token = requireCsrf()
    if (token === null || match.product_key === null) return
    try {
      if (match.snoozed) {
        const existing = snoozes.find(
          (snooze) => snooze.scope === 'product' && snooze.product_key === match.product_key,
        )
        if (existing) await reactivateSnooze(token, existing.id)
        showToast('Silenciamento removido.')
      } else {
        await snoozeProduct(token, match.product_key, 7)
        showToast('Produto silenciado por 7 dias.')
      }
      await loadSnoozes()
      refresh()
    } catch (err) {
      reportError(err, 'Não foi possível atualizar o silenciamento.')
    }
  }

  async function handleReactivateSnooze(snoozeId: number) {
    const token = requireCsrf()
    if (token === null) return
    try {
      await reactivateSnooze(token, snoozeId)
      showToast('Reativado.')
      await loadSnoozes()
      refresh()
    } catch (err) {
      reportError(err, 'Não foi possível reativar.')
    }
  }

  // S14-07: "Definir alvo" — edits the match's own rule via the Regras CRUD
  // (`PATCH /rules/{id}`), sending only `target_price_cents`.
  async function handleSetTarget(ruleId: number, targetCents: number) {
    const token = requireCsrf()
    if (token === null) return
    try {
      await updateRule(token, ruleId, { target_price_cents: targetCents })
      showToast('Alvo de preço salvo.')
      await loadRules()
      refresh()
    } catch (err) {
      reportError(err, 'Não foi possível salvar o alvo.')
    }
  }

  async function handleToggleGroupDuplicates() {
    const token = requireCsrf()
    if (token === null || feedSettings === null) return
    try {
      const next = await updateFeedSettings(token, !feedSettings.group_duplicates)
      setFeedSettings(next)
      refresh()
    } catch (err) {
      reportError(err, 'Não foi possível atualizar o agrupamento.')
    }
  }

  async function saveDigest(patch: Partial<{
    enabled: boolean
    sendAtLocal: string
    topN: number
    muteIndividual: boolean
  }>) {
    const token = requireCsrf()
    if (token === null || digest === null) return
    try {
      const result = await updateDigestSettings(token, {
        enabled: patch.enabled ?? digest.enabled,
        send_at_local: patch.sendAtLocal ?? digest.send_at_local,
        top_n: patch.topN ?? digest.top_n,
        mute_individual: patch.muteIndividual ?? digest.mute_individual,
      })
      setDigest(result)
    } catch (err) {
      reportError(err, 'Não foi possível salvar o digest.')
    }
  }

  // Contagem por regra vem sempre da lista completa (não filtrada) — é o que
  // aparece do lado de cada regra na trilha, mesmo quando outra regra está
  // selecionada.
  const ruleCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const match of matches) {
      counts.set(match.rule_id, (counts.get(match.rule_id) ?? 0) + 1)
    }
    return counts
  }, [matches])

  const visibleMatches: Match[] = useMemo(
    () => (selectedRuleId === null ? matches : matches.filter((match) => match.rule_id === selectedRuleId)),
    [matches, selectedRuleId],
  )

  const summary = useMemo(() => {
    const sent = visibleMatches.reduce(
      (count, match) => count + match.deliveries.filter((delivery) => delivery.status === 'sent').length,
      0,
    )
    const prices = visibleMatches
      .map((match) => match.price_cents)
      .filter((price): price is number => price !== null)
    return {
      matches: visibleMatches.length,
      sent,
      lowestPrice: prices.length > 0 ? Math.min(...prices) : null,
    }
  }, [visibleMatches])

  // S14-07 (barra lateral) — revisão 1, bloqueio (2): "Alvos de preço" —
  // every rule with a target, hit/gap computed from the rule's most RECENT
  // price (`Rule.history_30d`'s last point, #102/S14-09), never its all-time
  // minimum (`Rule.lowest_price_cents`, S7-06) — a rule stays "atingido"
  // forever once it ever dipped below the target if the historical minimum
  // is used instead of the current price. Same source `utils/target.ts`
  // (mirrors `packages.rules.target` server-side) already uses for a single
  // match's own `target_hit`/`target_gap_pct`, so this never disagrees with
  // a card's own badge.
  const targetRows: TargetRuleRow[] = useMemo(
    () =>
      rules
        .filter((rule): rule is Rule & { target_price_cents: number } => rule.target_price_cents !== null)
        .map((rule) => {
          const latestPriceCents = rule.history_30d?.at(-1)?.price_cents ?? null
          const hit = targetHit(latestPriceCents, rule.target_price_cents)
          const gapPct = targetGapPct(latestPriceCents, rule.target_price_cents)
          const progressPct =
            latestPriceCents !== null && latestPriceCents > 0
              ? Math.max(0, Math.min(100, Math.round((rule.target_price_cents / latestPriceCents) * 100)))
              : 0
          return { rule, latestPriceCents, hit, gapPct, progressPct }
        }),
    [rules],
  )

  // S14-07 (barra lateral): "Resumo de hoje" — only matches whose
  // `matched_at` falls on today's local calendar day. `matches` counts real
  // persisted rows (`grouped_match_ids.length`, same fix as SaudePage's
  // "Matches gerados"), never the number of cards a "Agrupar duplicatas"
  // fold happens to show.
  const todayStats = useMemo(() => {
    const now = new Date()
    const today = matches.filter((match) => isSameLocalDay(parseApiDate(match.matched_at), now))
    return {
      matches: today.reduce((sum, match) => sum + (match.grouped_match_ids?.length ?? 1), 0),
      duplicatesFolded: today.reduce((sum, match) => sum + ((match.seen_count ?? 1) - 1), 0),
      targetsHit: today.filter((match) => match.target_hit).length,
      snoozed: snoozes.length,
    }
  }, [matches, snoozes])

  const connectionLabel = CONNECTION_LABELS[connectionState]
  const stableCreateRule = useStableCallback(handleCreateRule)
  const stableCardSnooze = useStableCallback(handleCardSnooze)
  const stableSetTarget = useStableCallback(handleSetTarget)

  // S15-03: compact chrome while scrolled (chrome/scrollChrome.ts). The rails
  // only fold into icon strips while the grid actually has its 3 columns —
  // the width the grid really gets (the product panel can take 520px of it),
  // measured, not guessed from the viewport.
  const chromeMode = useScrollChrome(true)
  const headerActionsRef = useRef<HTMLDivElement>(null)
  const leftRailRef = useRef<HTMLElement>(null)
  const rightRailRef = useRef<HTMLDivElement>(null)
  const [gridElement, setGridElement] = useState<HTMLDivElement | null>(null)
  const [gridIsWide, setGridIsWide] = useState(false)
  const [openRails, setOpenRails] = useState({ left: false, right: false })
  const [railsPassed, setRailsPassed] = useState({ left: false, right: false })
  // S15-04: a rail that folds because it was scrolled out of view swaps faces
  // at once — it is off screen, and morphing it made the full, tall box flash
  // back into view (sticky) before shrinking. The folded box fades in where
  // it lands and its icons stagger in. Cleared after that entrance, so
  // opening/closing from the strip and the way back to the top keep their
  // morph.
  const [railsSnap, setRailsSnap] = useState({ left: false, right: false })
  const railsManaged = chromeMode !== 'off' && gridIsWide
  const railsCompact = chromeMode === 'compact' && gridIsWide
  // A rail only folds into its strip once the page has scrolled past it —
  // while any of it is still on screen it stays open and in the flow, so a
  // rail never collapses under the pointer of someone scrolling to reach its
  // bottom (a long rule/source list). Opened from the strip it is "pinned":
  // sticky, scrolling inside itself, until closed or back at the top.
  const railState = (side: 'left' | 'right') =>
    !railsManaged ? undefined : !railsCompact ? 'open' : openRails[side] ? 'pinned' : railsPassed[side] ? 'collapsed' : 'open'
  const leftState = railState('left')
  const rightState = railState('right')
  const leftCollapsed = leftState === 'collapsed'
  const rightCollapsed = rightState === 'collapsed'
  if (!railsCompact && (openRails.left || openRails.right)) setOpenRails({ left: false, right: false })
  if (!railsCompact && (railsPassed.left || railsPassed.right)) setRailsPassed({ left: false, right: false })

  useEffect(() => {
    if (!railsCompact) return
    // Measured on entering compact, when both rails are still open in the
    // flow: the scroll position at which each one's bottom leaves the band.
    const band = 84
    const bottomOf = (element: HTMLElement | null) =>
      element ? element.getBoundingClientRect().bottom + window.scrollY - band : Infinity
    const thresholds = { left: bottomOf(leftRailRef.current), right: bottomOf(rightRailRef.current) }
    let passed = { left: false, right: false }
    const check = () => {
      const y = window.scrollY
      const next = { left: passed.left || y > thresholds.left, right: passed.right || y > thresholds.right }
      if (next.left === passed.left && next.right === passed.right) return
      const snap = { left: next.left && !passed.left, right: next.right && !passed.right }
      passed = next
      markChromeAnimating()
      anchorScrollDuring('.feed-page__card', CHROME_SPRING_MS + 80)
      setRailsSnap(snap)
      setRailsPassed(next)
      window.setTimeout(() => setRailsSnap({ left: false, right: false }), 450)
    }
    check()
    window.addEventListener('scroll', check, { passive: true })
    return () => window.removeEventListener('scroll', check)
  }, [railsCompact])

  useEffect(() => {
    if (gridElement === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setGridIsWide(entry.contentRect.width > 1100))
    observer.observe(gridElement)
    return () => observer.disconnect()
  }, [gridElement])

  useEffect(() => {
    const element = headerActionsRef.current
    const unregisterFlip = element ? registerChromeFlip(element) : () => {}
    const unregisterAnchor = onBeforeChromeChange(() => anchorScrollDuring('.feed-page__card', CHROME_SPRING_MS + 80))
    return () => {
      unregisterFlip()
      unregisterAnchor()
    }
  }, [])

  function setRailOpen(side: 'left' | 'right', open: boolean, sectionId?: string) {
    markChromeAnimating()
    anchorScrollDuring('.feed-page__card', CHROME_SPRING_MS + 80)
    setOpenRails((current) => ({ ...current, [side]: open }))
    if (!open) return
    const rail = side === 'left' ? leftRailRef.current : rightRailRef.current
    const section = sectionId ? document.getElementById(sectionId) : null
    window.requestAnimationFrame(() => {
      rail?.scrollTo({ top: section ? Math.max(0, section.offsetTop - 16) : 0, behavior: 'smooth' })
      // Focus follows the click into the rail it opened (the strip it came
      // from is about to become inert).
      rail?.querySelector<HTMLElement>('.feed-rail__collapse')?.focus({ preventScroll: true })
    })
  }

  const leftStripItems: RailStripItem[] = [
    { sectionId: 'feed-rail-targets', label: 'Alvos de preço', icon: 'target' },
    { sectionId: 'feed-rail-snoozed', label: 'Silenciados', icon: 'snooze', flagged: snoozes.length > 0 },
    { sectionId: 'feed-rail-filter', label: 'Filtrar por regra', icon: 'filter', flagged: selectedRuleId !== null },
    { sectionId: 'feed-rail-sources', label: 'Fontes', icon: 'sources' },
  ]
  const rightStripItems: RailStripItem[] = [
    { sectionId: 'feed-side-summary', label: 'Resumo', icon: 'summary' },
    ...(digest !== null ? [{ sectionId: 'feed-side-digest', label: 'Digest diário', icon: 'digest' as const }] : []),
    { sectionId: 'feed-side-today', label: 'Resumo de hoje', icon: 'today' },
  ]

  return (
    <main className="feed-page">
      <Toast toast={toast} onDismiss={dismiss} />
      {/* S15-03: the band the compact chrome (capsule, docked controls)
          lives in — cards scroll under it, never under a bare control. */}
      <div className="feed-chrome-scrim" aria-hidden="true" />
      <div className="feed-page__header">
        <div className="feed-page__title">
          <h1>Feed ao vivo</h1>
          <p className="feed-page__subtitle">Ofertas encontradas pelas suas regras, em tempo real.</p>
        </div>
        <div ref={headerActionsRef} className="feed-page__header-actions">
          <span
            className="feed-page__connection-badge"
            role="status"
            style={{ color: connectionLabel.color, borderColor: connectionLabel.color }}
          >
            <span className="feed-page__connection-dot" style={{ background: connectionLabel.dot }} />
            {connectionLabel.label}
          </span>
          {feedSettings !== null && (
            <button
              type="button"
              className="plane-action plane-action--secondary fill-button feed-page__group-toggle"
              aria-pressed={feedSettings.group_duplicates}
              onClick={handleToggleGroupDuplicates}
            >
              Agrupar duplicatas: {feedSettings.group_duplicates ? 'ligado' : 'desligado'}
            </button>
          )}
          <button
            type="button"
            className="plane-action plane-action--secondary fill-button feed-page__refresh"
            onClick={refresh}
          >
            Atualizar
          </button>
        </div>
      </div>

      {loading && <p>Carregando…</p>}
      {error && (
        <p role="alert" className="feed-page__error">
          {error}
        </p>
      )}

      {!loading && !error && (
        <div className="product-panel-layout" data-panel-phase={panel.phase}>
          <div className="product-panel-layout__content">
        <div
          ref={setGridElement}
          className="feed-page__grid"
          data-rails={railsManaged ? chromeMode : undefined}
          data-left-rail={leftState}
          data-right-rail={rightState}
          data-left-snap={railsSnap.left || undefined}
          data-right-snap={railsSnap.right || undefined}
        >
          <aside ref={leftRailRef} id="feed-rail-left" className="plane-glass feed-rail">
            <div className="feed-rail__strip" inert={!leftCollapsed}>
              <RailStrip side="left" items={leftStripItems} controls="feed-rail-left" onOpen={(id) => setRailOpen('left', true, id)} />
            </div>
            <div className="feed-rail__full" inert={leftCollapsed}>
            <div className="feed-rail__full-inner">
            {leftState === 'pinned' && (
              <button
                type="button"
                className="feed-rail__collapse"
                aria-label="Recolher painel"
                aria-controls="feed-rail-left"
                aria-expanded={true}
                title="Recolher painel"
                onClick={() => setRailOpen('left', false)}
              >
                <RailChevron direction="left" />
              </button>
            )}
            <div id="feed-rail-targets">
              <div className="feed-rail__eyebrow">Alvos de preço</div>
              {targetRows.length === 0 && <p className="feed-rail__empty">Nenhum alvo definido ainda.</p>}
              <div className="feed-rail__list">
                {targetRows.map(({ rule, latestPriceCents, hit, gapPct, progressPct }) => (
                  <div key={rule.id} className="feed-target">
                    <div className="feed-target__head">
                      <span className="feed-target__name">{rule.name}</span>
                      <span className={hit ? 'feed-target__status feed-target__status--hit' : 'feed-target__status'}>
                        {hit ? 'atingido' : `falta ${gapPct ?? 0}%`}
                      </span>
                    </div>
                    <div className="feed-target__bar">
                      <div
                        className={hit ? 'feed-target__bar-fill feed-target__bar-fill--hit' : 'feed-target__bar-fill'}
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    <div className="feed-target__foot">
                      <span>alvo {formatCurrency(rule.target_price_cents as number)}</span>
                      <span>{latestPriceCents !== null ? formatCurrency(latestPriceCents) : 'sem preço recente'}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="feed-rail__divider" />
            <div id="feed-rail-snoozed">
              <div className="feed-rail__eyebrow">Silenciados</div>
              {snoozes.length === 0 && <p className="feed-rail__empty">Nada silenciado agora.</p>}
              <div className="feed-rail__list">
                {snoozes.map((snooze) => (
                  <div key={snooze.id} className="feed-snooze">
                    <div>
                      <div className="feed-snooze__label">{snooze.label}</div>
                      <div className="feed-snooze__meta">
                        {snooze.scope === 'rule' ? 'regra' : 'produto'} ·{' '}
                        {formatSnoozeRemaining(snooze.until, new Date())}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="plane-action plane-action--secondary plane-action--compact feed-snooze__reactivate"
                      onClick={() => handleReactivateSnooze(snooze.id)}
                    >
                      Reativar
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div className="feed-rail__divider" />
            <div id="feed-rail-filter">
              <div className="feed-rail__eyebrow">Filtrar por regra</div>
              <div className="feed-rail__list">
                <button
                  type="button"
                  className={`feed-rail__rule${selectedRuleId === null ? ' feed-rail__rule--active' : ''}`}
                  onClick={() => setSelectedRuleId(null)}
                >
                  <span>Todas as regras</span>
                  <span>{matches.length}</span>
                </button>
                {rules.map((rule) => (
                  <button
                    key={rule.id}
                    type="button"
                    className={`feed-rail__rule${selectedRuleId === rule.id ? ' feed-rail__rule--active' : ''}`}
                    onClick={() => setSelectedRuleId(rule.id)}
                  >
                    <span>{rule.name}</span>
                    <span>{ruleCounts.get(rule.id) ?? 0}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="feed-rail__divider" />
            <div id="feed-rail-sources">
              <div className="feed-rail__eyebrow">Fontes</div>
              <div className="feed-rail__sources">
                {sources.map((source) => (
                  <div key={source.id} className="feed-rail__source">
                    <span>{source.name}</span>
                    <span
                      className="feed-rail__status"
                      style={{ color: source.active ? 'var(--plane-status-good)' : 'var(--plane-status-neutral)' }}
                    >
                      <span
                        className="feed-rail__status-dot"
                        style={{
                          background: source.active
                            ? 'var(--plane-status-good-dot)'
                            : 'var(--plane-status-neutral-dot)',
                        }}
                      />
                      {source.active ? 'ativa' : 'inativa'}
                    </span>
                  </div>
                ))}
                {sources.length === 0 && <p className="feed-rail__empty">Nenhuma fonte cadastrada.</p>}
              </div>
            </div>
            </div>
            </div>
          </aside>

          <FeedMatchList
            visibleMatches={visibleMatches}
            hasAnyMatch={matches.length > 0}
            rules={rules}
            sources={sources}
            recipients={recipients}
            onOpenProduct={panel.open}
            onCreateRule={stableCreateRule}
            onSnooze={stableCardSnooze}
            onSetTarget={stableSetTarget}
          />

          <div ref={rightRailRef} id="feed-rail-right" className="feed-page__side-rail">
            <div className="feed-rail__strip feed-side__strip" inert={!rightCollapsed}>
              <RailStrip className="plane-glass" side="right" items={rightStripItems} controls="feed-rail-right" onOpen={(id) => setRailOpen('right', true, id)} />
            </div>
            <div className="feed-rail__full" inert={rightCollapsed}>
            <div className="feed-side__full-inner">
            {rightState === 'pinned' && (
              <button
                type="button"
                className="feed-rail__collapse"
                aria-label="Recolher painel"
                aria-controls="feed-rail-right"
                aria-expanded={true}
                title="Recolher painel"
                onClick={() => setRailOpen('right', false)}
              >
                <RailChevron direction="right" />
              </button>
            )}
            <aside id="feed-side-summary" className="plane-glass feed-summary">
              <div className="feed-rail__eyebrow">Resumo</div>
              <div className="feed-summary__grid">
                <div className="feed-summary__tile">
                  <div className="feed-summary__label">Matches</div>
                  <div className="feed-summary__value">{summary.matches}</div>
                </div>
                <div className="feed-summary__tile">
                  <div className="feed-summary__label">Enviados</div>
                  <div className="feed-summary__value">{summary.sent}</div>
                </div>
                {/* S11-07: sem tile de "Mensagens lidas" — nenhum contador
                    existente conta mensagens (`vista` conta matches
                    persistidos, por par mensagem×regra), então o número seria
                    falso. Volta na Fase 2, com um contador por mensagem. */}
                <div className="feed-summary__tile feed-summary__tile--wide">
                  <div className="feed-summary__label">Menor preço</div>
                  <div className="feed-summary__value feed-summary__value--price">
                    {summary.lowestPrice !== null ? formatCurrency(summary.lowestPrice) : '—'}
                  </div>
                </div>
              </div>
            </aside>

            {digest !== null && (
              <aside id="feed-side-digest" className="plane-glass feed-digest">
                <div className="feed-rail__eyebrow">Digest diário</div>
                <p className="feed-digest__description">
                  Um resumo por dia com os melhores preços. Alvos atingidos continuam avisando na hora.
                </p>
                <div className="feed-digest__row">
                  <label className="feed-digest__field">
                    Horário
                    <input
                      type="time"
                      value={digest.send_at_local}
                      onChange={(event) => saveDigest({ sendAtLocal: event.target.value })}
                    />
                  </label>
                  <label className="feed-digest__field">
                    Itens
                    <select
                      value={digest.top_n}
                      onChange={(event) => saveDigest({ topN: Number(event.target.value) })}
                    >
                      {TOP_N_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          Top {option}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  className="feed-digest__toggle"
                  aria-pressed={digest.enabled}
                  onClick={() => saveDigest({ enabled: !digest.enabled })}
                >
                  <span>Ativar digest diário</span>
                  <span className={digest.enabled ? 'feed-toggle-switch feed-toggle-switch--on' : 'feed-toggle-switch'}>
                    <span className="feed-toggle-switch__knob" />
                  </span>
                </button>
                <button
                  type="button"
                  className="feed-digest__toggle"
                  aria-pressed={digest.mute_individual}
                  onClick={() => saveDigest({ muteIndividual: !digest.mute_individual })}
                >
                  <span>Silenciar pings individuais</span>
                  <span
                    className={
                      digest.mute_individual ? 'feed-toggle-switch feed-toggle-switch--on' : 'feed-toggle-switch'
                    }
                  >
                    <span className="feed-toggle-switch__knob" />
                  </span>
                </button>
                <div className="feed-digest__next">
                  Próximo envio: {digest.next_run_at_local} · {digest.queue_count}{' '}
                  {digest.queue_count === 1 ? 'item na fila' : 'itens na fila'}
                </div>
              </aside>
            )}

            <div id="feed-side-today" className="plane-pearl feed-today">
              <div className="feed-rail__eyebrow">Resumo de hoje</div>
              <div className="feed-today__grid">
                <div className="feed-today__tile">
                  <div className="feed-today__label">Matches</div>
                  <div className="feed-today__value">{todayStats.matches}</div>
                </div>
                <div className="feed-today__tile">
                  <div className="feed-today__label">Duplicatas unidas</div>
                  <div className="feed-today__value">{todayStats.duplicatesFolded}</div>
                </div>
                <div className="feed-today__tile">
                  <div className="feed-today__label">Alvos atingidos</div>
                  <div className="feed-today__value">{todayStats.targetsHit}</div>
                </div>
                <div className="feed-today__tile">
                  <div className="feed-today__label">Silenciados</div>
                  <div className="feed-today__value">{todayStats.snoozed}</div>
                </div>
              </div>
            </div>
            </div>
            </div>
          </div>
        </div>
          </div>
          {panel.phase !== 'closed' && panel.productKey !== null && (() => {
            // S14-08 parte 2 (rodada 2): the panel only knows a
            // `product_key` — the rule its "Alvo de preço"/"Silenciar"
            // blocks act on is the product's most-recently-matched match
            // (never the historical minimum or an arbitrary rule), read
            // straight from the live `matches` already loaded here, same as
            // every other card action on this page.
            const panelMatch = latestMatchForProduct(matches, panel.productKey as string)
            const panelRule = panelMatch ? rules.find((rule) => rule.id === panelMatch.rule_id) : undefined
            return (
              <ProductPanel
                productKey={panel.productKey}
                phase={panel.phase}
                onClose={panel.close}
                onSaveTarget={panelMatch ? (cents) => handleSetTarget(panelMatch.rule_id, cents) : undefined}
                onCreateRule={() => handleCreateRule(panel.productKey as string)}
                onSnooze={panelMatch ? () => handleCardSnooze(panelMatch) : undefined}
                onEdited={() => refresh()}
                targetPriceCents={panelMatch?.target_price_cents ?? null}
                targetRuleName={panelRule?.name}
                snoozed={panelMatch?.snoozed ?? false}
              />
            )
          })()}
        </div>
      )}
    </main>
  )
}
