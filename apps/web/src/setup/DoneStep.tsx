import { Link } from 'react-router-dom'
import type { SetupStatus } from '../api/setup'

interface Check {
  label: string
  ok: boolean
  detail: string
}

function checksOf(status: SetupStatus): Check[] {
  return [
    {
      label: 'Monitor conectado',
      ok: status.listener_online,
      detail: status.listener_online
        ? 'O processo que lê o Telegram está respondendo.'
        : 'Ainda não respondeu. Leva até um minuto depois de configurar; se persistir, veja a página Saúde.',
    },
    {
      label: 'Conta do Telegram',
      ok: status.steps.credentials && status.steps.login,
      detail: status.steps.login ? 'Sessão salva neste computador.' : 'Falta entrar na conta (passos 1 e 2).',
    },
    {
      label: 'Bot de alertas',
      ok: status.steps.bot,
      detail:
        status.bot.username !== null
          ? `@${status.bot.username}`
          : status.steps.bot
            ? 'Configurado.'
            : 'Falta o token do bot (passo 3).',
    },
    {
      label: 'Destinatário',
      ok: status.steps.recipient,
      detail: status.steps.recipient
        ? `${status.recipients} pessoa(s) recebem os alertas.`
        : 'Ninguém cadastrado ainda (passo 3).',
    },
    {
      label: 'Grupos monitorados',
      ok: status.steps.groups,
      detail: status.steps.groups ? `${status.sources} grupo(s) ativo(s).` : 'Escolha ao menos um grupo (passo 4).',
    },
    {
      label: 'Regras ativas',
      ok: status.steps.rule,
      detail: status.steps.rule ? `${status.rules} regra(s) ativa(s).` : 'Crie a primeira regra (passo 5).',
    },
  ]
}

/** Step 6: live checklist; "Tudo pronto" only when everything is really up. */
export function DoneStep({ status }: { status: SetupStatus }) {
  const checks = checksOf(status)
  return (
    <div className="setup-stack">
      {status.complete ? (
        <p role="status" className="setup-ok setup-ok--big">
          Tudo pronto. O teleyes está monitorando os grupos escolhidos e vai avisar pelo bot quando uma
          regra bater.
        </p>
      ) : (
        <p className="setup-note">Esta lista é atualizada sozinha. Falta o que estiver pendente abaixo.</p>
      )}
      <ul className="setup-checks" aria-label="Verificação ao vivo">
        {checks.map((check) => (
          <li key={check.label} className="setup-check" data-ok={check.ok}>
            <span className="setup-check__mark" aria-hidden="true">
              {check.ok ? '✓' : '•'}
            </span>
            <span className="setup-check__text">
              <span className="setup-check__label">
                {check.label}
                <span className="setup-check__word">{check.ok ? ' — ok' : ' — pendente'}</span>
              </span>
              <span className="setup-check__detail">{check.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {status.complete && (
        <div className="setup-actions">
          <Link className="plane-action setup-button setup-link-button" to="/feed">
            Ir para o Feed
          </Link>
          <Link className="plane-action plane-action--secondary setup-button setup-link-button" to="/regras">
            Ver as regras
          </Link>
        </div>
      )}
    </div>
  )
}
