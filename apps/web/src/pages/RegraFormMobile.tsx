import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { testRule } from '../api/rules'
import type { RuleTestInput } from '../api/rules'
import type { RuleTestResult } from '../api/types'
import { BottomSheet } from '../components/BottomSheet'
import { formatMatchedAt } from '../utils/dates'
import { previewRuleMatch } from '../utils/ruleMatchPreview'
import { parseTermList } from '../utils/termList'
import type { RulePreview } from '../rules/useRulePreview'
import './RegraFormMobile.css'

const money = (cents: number | null): string =>
  cents === null ? '—' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/**
 * S24-03c: the rule form as a full-screen modal on the phone (comp 18).
 * Fields come in as `children` (the page owns the state); this shell owns the
 * header (Cancelar + title), the saved-offers preview, the "Testar" section and
 * the fixed footer (Testar + Salvar regra). It reuses BottomSheet for the
 * back-button / Esc / focus mechanics.
 */
export function RegraFormMobile({
  open,
  isEditing,
  csrfToken,
  testInput,
  preview,
  submitting,
  error,
  onClose,
  onSubmit,
  children,
  modeLink,
}: {
  open: boolean
  isEditing: boolean
  csrfToken: string | null
  testInput: RuleTestInput
  preview: RulePreview
  submitting: boolean
  error: string | null
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  children: ReactNode
  modeLink: ReactNode
}) {
  const title = isEditing ? 'Editar regra' : 'Nova regra'
  return (
    <BottomSheet open={open} onClose={onClose} title={title} className="regra-form-sheet">
      <FormShell
        title={title}
        csrfToken={csrfToken}
        testInput={testInput}
        preview={preview}
        submitting={submitting}
        error={error}
        isEditing={isEditing}
        onClose={onClose}
        onSubmit={onSubmit}
        modeLink={modeLink}
      >
        {children}
      </FormShell>
    </BottomSheet>
  )
}

function FormShell({
  title,
  isEditing,
  csrfToken,
  testInput,
  preview,
  submitting,
  error,
  onClose,
  onSubmit,
  children,
  modeLink,
}: Omit<Parameters<typeof RegraFormMobile>[0], 'open'> & { title: string }) {
  const [testOpen, setTestOpen] = useState(false)
  const [sample, setSample] = useState('')
  const [result, setResult] = useState<RuleTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const requestId = useRef(0)
  const testRef = useRef<HTMLElement>(null)
  const hasTerms = parseTermList(testInput.include_terms).length > 0

  const fetchResult = () => {
    const id = ++requestId.current
    if (csrfToken === null || !hasTerms) {
      setTestError(hasTerms ? 'Sessão sem token. Recarregue a página.' : 'Adicione pelo menos um termo incluído.')
      setResult(null)
      return
    }
    setTesting(true)
    setTestError(null)
    testRule(csrfToken, testInput)
      .then((next) => {
        if (requestId.current === id) setResult(next)
      })
      .catch(() => {
        if (requestId.current === id) setTestError('Não foi possível testar a regra.')
      })
      .finally(() => {
        if (requestId.current === id) setTesting(false)
      })
  }

  const openTest = () => {
    if (testOpen) {
      requestId.current += 1
      setTesting(false)
      setTestOpen(false)
      return
    }
    setTestOpen(true)
    fetchResult()
  }

  useEffect(() => {
    if (testOpen) testRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [testOpen])

  const total = preview.state === 'ready' ? preview.total : null

  return (
    <form className="regra-form-m" onSubmit={onSubmit}>
      <header className="regra-form-m__top">
        <button type="button" className="regra-form-m__cancel" onClick={onClose}>
          Cancelar
        </button>
        <span className="regra-form-m__title" aria-hidden="true">
          {title}
        </span>
        <span className="regra-form-m__top-spacer" aria-hidden="true" />
      </header>

      <div className="regra-form-m__fields">
        {children}

        <div className="regra-form-m__preview" aria-live="polite" data-testid="rule-preview-mobile">
          {preview.state === 'loading' && <p>Calculando quantas promoções já salvas bateriam…</p>}
          {preview.state === 'error' && <p>Não foi possível calcular a prévia agora.</p>}
          {preview.state === 'idle' && <p>Adicione um termo para ver quantas promoções já salvas bateriam.</p>}
          {preview.state === 'ready' && (
            <>
              <p className="regra-form-m__preview-count">
                <strong>
                  {preview.total === 1
                    ? '1 promoção já salva bateria'
                    : `${preview.total} promoções já salvas bateriam`}
                </strong>
                <span className="regra-form-m__preview-window">{preview.windowDays} dias</span>
              </p>
              {total !== null && total > 0 && (
                <button type="button" className="regra-form-m__see" onClick={openTest}>
                  {testOpen ? 'Ocultar' : `Ver ${total === 1 ? 'a 1' : `as ${total}`}`}
                </button>
              )}
            </>
          )}
        </div>

        {testOpen && (
          <section ref={testRef} className="regra-form-m__test" aria-label="Testar regra">
            <label className="regra-form-m__test-field">
              Mensagem de exemplo
              <input value={sample} onChange={(event) => setSample(event.target.value)} />
            </label>
            {sample.trim() !== '' && (
              <p className="regra-form-m__verdict">
                {previewRuleMatch(sample, testInput.include_terms, testInput.exclude_terms ?? null)
                  ? '✅ Bateria com esta regra'
                  : '❌ Não bateria com esta regra'}
              </p>
            )}
            {testing && <p role="status">Buscando mensagens…</p>}
            {testError && <p role="alert" className="regra-form-m__error">{testError}</p>}
            {!testing && result && result.messages.length === 0 && (
              <p>Nenhuma promoção já salva bateu com esses termos nos últimos {result.window_days} dias.</p>
            )}
            {!testing && result && result.messages.length > 0 && (
              <ul className="regra-form-m__list">
                {result.messages.map((message, index) => (
                  <li key={index}>
                    <p className="regra-form-m__list-text">{message.message_text}</p>
                    <p className="regra-form-m__list-meta">
                      {message.source_name} · {formatMatchedAt(message.matched_at)} · {money(message.price_cents)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {modeLink}
        {error && (
          <p role="alert" className="regra-form-m__error">
            {error}
          </p>
        )}
      </div>

      <footer className="regra-form-m__footer">
        <button type="button" className="plane-action plane-action--secondary regra-form-m__btn" onClick={openTest}>
          {testOpen ? 'Fechar teste' : 'Testar'}
        </button>
        <button type="submit" className="plane-action fill-button regra-form-m__btn" disabled={submitting}>
          {submitting ? 'Salvando…' : isEditing ? 'Salvar alterações' : 'Salvar regra'}
        </button>
      </footer>
    </form>
  )
}
