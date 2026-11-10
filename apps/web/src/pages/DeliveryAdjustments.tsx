import { HelpTip } from '../components/HelpTip'
import type { DigestSettings } from '../api/types'
import { AnchoredPopover } from '../components/AnchoredPopover'
import './RegrasPage.css'

/** `digest.next_run_at_local` is already a "YYYY-MM-DD HH:MM" wall-clock
 * string in the display timezone (`app.routers.digest`) — not an instant to
 * reinterpret, so this is plain string slicing, never `new Date(...)` (the
 * S13-01 guard only allows that for `utils/dates.ts`, and this value has no
 * zone to get wrong in the first place). */
function formatNextDigestRun(value: string): string {
  const [datePart, timePart] = value.split(' ')
  const [, month, day] = datePart.split('-')
  return `${day}/${month} ${timePart}`
}

/**
 * S21-02: "Entrega dos alertas" (S14-09), absorbed from its own panel into a
 * popover opened by the "Ajustes de entrega" button in the Destinatários
 * header. Same content and same `PUT /digest` as before — digest time and
 * size, "preço-alvo atingido" (always an immediate ping), the common-match rule,
 * and how a repeated offer is handled.
 */
function DeliveryBody({
  digest,
  error,
  saving,
  onChange,
  onSave,
  inline,
}: {
  digest: DigestSettings | null
  error: string | null
  saving: boolean
  onChange: (next: DigestSettings) => void
  onSave: () => void
  inline: boolean
}) {
  return (
    <>
      <p className="delivery-panel__intro">Uma decisão por tipo de evento — o restante pode ir no resumo diário.</p>
      {error && (
        <p role="alert" className="regras-panel__error">
          {error}
        </p>
      )}
      {!digest && !error && <p role="status">Carregando configuração…</p>}
      {digest && (
        <div className="delivery-panel__grid">
          <div className="delivery-card">
            <strong>Preço-alvo atingido</strong>
            <span>Ping imediato — fura o resumo diário e o silêncio da regra ou do produto.</span>
            <span className="delivery-card__state">
              <i /> prioritário
            </span>
          </div>
          <div className="delivery-card delivery-card--controls">
            <strong>Oferta comum</strong>
            <div className="delivery-card__row">
              <label>
                <input
                  type="checkbox"
                  checked={digest.enabled}
                  onChange={(event) => onChange({ ...digest, enabled: event.target.checked })}
                />
                Resumo diário
              </label>
              <HelpTip term="Resumo diário" align="right">
                Em vez de vários avisos, você recebe uma mensagem por dia com as melhores ofertas.
              </HelpTip>
            </div>
            <label>
              Horário
              <input
                type="time"
                value={digest.send_at_local}
                onChange={(event) => onChange({ ...digest, send_at_local: event.target.value })}
              />
            </label>
            <label>
              Máximo de itens
              <span className="delivery-stepper">
                {inline && (
                  <button
                    type="button"
                    aria-label="Diminuir máximo de itens"
                    disabled={digest.top_n <= 1}
                    onClick={() => onChange({ ...digest, top_n: Math.max(1, digest.top_n - 1) })}
                  >
                    −
                  </button>
                )}
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={digest.top_n}
                  onChange={(event) => onChange({ ...digest, top_n: Number(event.target.value) })}
                />
                {inline && (
                  <button
                    type="button"
                    aria-label="Aumentar máximo de itens"
                    disabled={digest.top_n >= 50}
                    onClick={() => onChange({ ...digest, top_n: Math.min(50, digest.top_n + 1) })}
                  >
                    +
                  </button>
                )}
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={digest.mute_individual}
                onChange={(event) => onChange({ ...digest, mute_individual: event.target.checked })}
              />
              Não enviar ofertas comuns individualmente
            </label>
            <span>
              Próximo envio: {formatNextDigestRun(digest.next_run_at_local)} · {digest.queue_count}{' '}
              {digest.queue_count === 1 ? 'item' : 'itens'} na fila
            </span>
            {/* The digest only collects common offers that were held back. With
                individual sending on, every offer already went out and the
                digest stays empty, which looked like "the digest never arrives". */}
            {digest.enabled && !digest.mute_individual && (
              <span className="delivery-card__hint" role="note">
                Cada oferta comum já chega na hora, então o resumo fica vazio. Marque a opção acima para
                receber tudo em uma mensagem por dia.
              </span>
            )}
          </div>
          <div className="delivery-card">
            <strong>Repetição da mesma oferta</strong>
            <span>No mesmo minuto, agrupa e não envia de novo. Anunciou de novo depois disso (estoque renovado, por exemplo)? Você recebe outro alerta.</span>
            <span className="delivery-card__state delivery-card__state--neutral">
              <i /> silencioso
            </span>
          </div>
        </div>
      )}
      {digest && (
        <div className="delivery-panel__footer">
          <button
            type="button"
            className="plane-action plane-action--compact"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? 'Salvando…' : 'Salvar entrega'}
          </button>
        </div>
      )}
    </>
  )
}

export function DeliveryAdjustments(props: {
  digest: DigestSettings | null
  error: string | null
  saving: boolean
  onChange: (next: DigestSettings) => void
  onSave: () => void
} & { inline?: boolean }) {
  const { inline = false, ...rest } = props
  if (inline) {
    return (
      <div className="delivery-inline">
        <DeliveryBody {...rest} inline />
      </div>
    )
  }
  return (
    <AnchoredPopover
      triggerLabel="Ajustes de entrega"
      triggerContent="Ajustes de entrega"
      triggerClassName="plane-action plane-action--secondary regras-section-row__button"
      title="Entrega dos alertas"
      align="right"
      wide
    >
      <DeliveryBody {...rest} inline={false} />
    </AnchoredPopover>
  )
}
