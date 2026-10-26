import { Link } from 'react-router-dom'
import { useSetupStatus } from '../hooks/useSetupStatus'
import type { SetupStepId } from '../api/setup'
import './SetupBanner.css'

const MESSAGES: Record<Exclude<SetupStepId, 'done'>, { text: string; cta: string }> = {
  credentials: {
    text: 'O teleyes ainda não está ligado ao seu Telegram, então nada é lido nem avisado.',
    cta: 'Configurar o Telegram',
  },
  login: {
    text: 'Falta entrar com a conta do Telegram que lê os grupos.',
    cta: 'Continuar a configuração',
  },
  bot: { text: 'Falta configurar o bot que envia os alertas.', cta: 'Continuar a configuração' },
  recipient: {
    text: 'Falta cadastrar quem recebe os alertas.',
    cta: 'Continuar a configuração',
  },
  groups: { text: 'Falta escolher os grupos para monitorar.', cta: 'Continuar a configuração' },
  rule: { text: 'Falta criar a primeira regra.', cta: 'Continuar a configuração' },
}

/**
 * S19-02: the call to action to the first-run wizard, on the Feed and on Saúde. It
 * shows only while the wizard has something left to do, and not at all in the demo
 * (the API answers 403 there) or when the status cannot be read: it never guesses.
 */
export function SetupBanner() {
  const { status, unavailable } = useSetupStatus()
  if (status === null || unavailable !== null || status.next_step === 'done') return null
  // A reply that is not a setup status (an old server, a proxy page) shows nothing.
  const message = MESSAGES[status.next_step]
  if (message === undefined) return null
  return (
    <aside className="plane-pearl setup-banner" aria-label="Configuração pendente">
      <p className="setup-banner__text">{message.text}</p>
      <Link className="plane-action setup-banner__cta" to="/configuracao">
        {message.cta}
      </Link>
    </aside>
  )
}

/**
 * The way back into the wizard once everything is done ("Configurações"): reconnecting
 * the account, changing the bot, adding a recipient or another group. Hidden in the
 * demo and while the banner is already offering the wizard.
 */
export function SetupReopenLink() {
  const { status, unavailable } = useSetupStatus()
  if (status === null || unavailable !== null || status.next_step !== 'done') return null
  return (
    <p className="setup-reopen">
      <Link to="/configuracao">Abrir o assistente de configuração do Telegram</Link>
    </p>
  )
}
