import { useState } from 'react'
import type { FormEvent } from 'react'
import { CSRF_MISSING_MESSAGE } from '../auth/AuthContext'
import { requestListenerReload } from '../api/listener'
import { createRule } from '../api/rules'
import { TermChipsInput } from '../components/TermChipsInput'
import { parseOptionalPriceInput } from '../utils/priceInput'
import { parseTermList } from '../utils/termList'
import { useFillOrigin } from '../utils/useFillOrigin'
import { errorMessage } from './timers'
import type { StepProps } from './types'

interface RuleTemplate {
  id: string
  label: string
  name: string
  /** Same format as the Regras page: comma = alternatives, `+` = every part. */
  includeTerms: string
  priceHint: string
}

const TEMPLATES: RuleTemplate[] = [
  {
    id: 'gpu',
    label: 'Placa de vídeo RTX 5070',
    name: 'Placa de vídeo RTX 5070',
    includeTerms: 'rtx 5070, rtx5070',
    priceHint: 'Ex.: 4.500 (só avisa até esse valor)',
  },
  {
    id: 'ssd',
    label: 'SSD NVMe 1TB',
    name: 'SSD NVMe 1TB',
    includeTerms: 'ssd + nvme + 1tb',
    priceHint: 'Ex.: 450',
  },
  {
    id: 'ram',
    label: 'Memória DDR5 32GB',
    name: 'Memória DDR5 32GB',
    includeTerms: 'ddr5 + 32gb',
    priceHint: 'Ex.: 700',
  },
  { id: 'custom', label: 'Regra livre', name: '', includeTerms: '', priceHint: 'Ex.: 1.200' },
]

/** Step 5: the first rule, from a template, then "Aplicar regras" so the monitor loads it. */
export function RuleStep({ status, csrfToken, onRefresh }: StepProps) {
  const fillOrigin = useFillOrigin()
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [terms, setTerms] = useState('')
  const [price, setPrice] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const template = TEMPLATES.find((candidate) => candidate.id === templateId) ?? null

  const choose = (next: RuleTemplate) => {
    setTemplateId(next.id)
    setName(next.name)
    setTerms(next.includeTerms)
    setPrice('')
    setError(null)
    setCreated(null)
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (trimmedName === '') {
      setError('Dê um nome para a regra.')
      return
    }
    if (parseTermList(terms).length === 0) {
      setError('Informe pelo menos um termo para procurar (digite e tecle Enter).')
      return
    }
    const parsedPrice = parseOptionalPriceInput(price)
    if (parsedPrice.error !== null) {
      setError(parsedPrice.error)
      return
    }
    if (csrfToken === null) {
      setError(CSRF_MISSING_MESSAGE)
      return
    }
    setBusy(true)
    setError(null)
    createRule(csrfToken, {
      name: trimmedName,
      include_terms: terms,
      max_price_cents: parsedPrice.cents,
    })
      .then(async (rule) => {
        setCreated(rule.name)
        setTemplateId(null)
        setAdding(false)
        // The listener reads rules from the database only when asked to reload.
        try {
          await requestListenerReload(csrfToken)
        } catch (failure) {
          setError(
            `A regra foi criada, mas o monitor não recebeu o pedido de aplicar (${errorMessage(failure, 'erro')}). Use "Aplicar regras" na página Regras.`,
          )
        }
        onRefresh()
      })
      .catch((failure: unknown) => setError(errorMessage(failure, 'Não foi possível criar a regra.')))
      .finally(() => setBusy(false))
  }

  const showPicker = !status.steps.rule || adding

  return (
    <div className="setup-stack">
      {status.steps.rule && !adding && (
        <>
          <p className="setup-note">
            Você tem {status.rules} regra(s) ativa(s). As regras podem ser editadas a qualquer momento na
            página Regras.
          </p>
          <div className="setup-actions">
            <button
              type="button"
              className="plane-action plane-action--secondary setup-button"
              onClick={() => setAdding(true)}
            >
              Criar outra regra
            </button>
          </div>
        </>
      )}

      {created !== null && (
        <p role="status" className="setup-ok">
          Regra “{created}” criada e enviada ao monitor.
        </p>
      )}

      {showPicker && (
        <>
          <p className="setup-note">
            Uma regra diz o que procurar nas mensagens. Escolha um modelo e ajuste, ou crie uma livre.
          </p>
          <div className="setup-templates" role="group" aria-label="Modelos de regra">
            {TEMPLATES.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="setup-template"
                aria-pressed={templateId === candidate.id}
                onClick={() => choose(candidate)}
              >
                {candidate.label}
              </button>
            ))}
          </div>
        </>
      )}

      {showPicker && template !== null && (
        <form className="setup-stack" onSubmit={submit} noValidate>
          <label className="setup-field">
            Nome da regra
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} />
          </label>
          <TermChipsInput
            id="setup-rule-terms"
            label="O que procurar"
            value={terms}
            onChange={setTerms}
            helper="Digite um termo e tecle Enter. Vírgula separa alternativas; use + para exigir várias partes (ex.: ssd + 1tb)."
          />
          <label className="setup-field">
            Preço máximo em R$ (opcional)
            <input
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              inputMode="decimal"
              placeholder={template.priceHint}
            />
          </label>
          {error !== null && (
            <p role="alert" className="setup-error">
              {error}
            </p>
          )}
          <div className="setup-actions">
            <button
              type="submit"
              className="plane-action fill-button setup-button"
              onPointerDown={fillOrigin}
              disabled={busy}
            >
              {busy ? 'Criando…' : 'Criar regra e aplicar'}
            </button>
            {adding && (
              <button
                type="button"
                className="plane-action plane-action--secondary setup-button"
                onClick={() => {
                  setAdding(false)
                  setTemplateId(null)
                }}
              >
                Cancelar
              </button>
            )}
          </div>
        </form>
      )}
      {(!showPicker || template === null) && error !== null && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
    </div>
  )
}
