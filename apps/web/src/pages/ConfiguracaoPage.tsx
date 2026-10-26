import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useSetupStatus } from '../hooks/useSetupStatus'
import type { SetupStepId, SetupStatus } from '../api/setup'
import { BotStep } from '../setup/BotStep'
import { CredentialsStep } from '../setup/CredentialsStep'
import { DoneStep } from '../setup/DoneStep'
import { GroupsStep } from '../setup/GroupsStep'
import { LoginStep } from '../setup/LoginStep'
import { RuleStep } from '../setup/RuleStep'
import { StepCard } from '../setup/StepCard'
import type { StepState } from '../setup/StepCard'
import '../styles/materials.css'
import '../components/FillButton.css'
import './ConfiguracaoPage.css'

const POLL_MS = 4000

type StepKey = 'credentials' | 'login' | 'bot' | 'groups' | 'rule' | 'done'

/** The server reports `recipient` as its own step; in the wizard it belongs to the bot step. */
function currentStep(next: SetupStepId): StepKey {
  return next === 'recipient' ? 'bot' : next
}

function stepStates(status: SetupStatus): Record<StepKey, StepState> {
  const done: Record<StepKey, boolean> = {
    credentials: status.steps.credentials,
    login: status.steps.login,
    bot: status.steps.bot && status.steps.recipient,
    groups: status.steps.groups,
    rule: status.steps.rule,
    done: status.complete,
  }
  const current = currentStep(status.next_step)
  const states = {} as Record<StepKey, StepState>
  for (const key of Object.keys(done) as StepKey[]) {
    states[key] = done[key] ? 'done' : key === current ? 'current' : 'todo'
  }
  return states
}

function summaries(status: SetupStatus): Record<StepKey, string | undefined> {
  const login = status.login
  return {
    credentials: status.credentials.configured
      ? status.credentials.source === 'env'
        ? 'Definidas no .env'
        : 'Salvas neste computador'
      : 'api_id e api_hash do my.telegram.org',
    login:
      login.state === 'authorized'
        ? 'Conta conectada'
        : login.state === 'awaiting_code'
          ? 'Aguardando o código'
          : login.state === 'awaiting_password'
            ? 'Aguardando a senha de duas etapas'
            : 'Telefone, código e senha',
    bot: status.steps.bot
      ? `${status.bot.username !== null ? `@${status.bot.username}` : 'Bot configurado'} · ${status.recipients} destinatário(s)`
      : 'Token do @BotFather e quem recebe',
    groups: status.steps.groups ? `${status.sources} grupo(s) monitorado(s)` : 'Quais grupos observar',
    rule: status.steps.rule ? `${status.rules} regra(s) ativa(s)` : 'O que procurar nas mensagens',
    done: status.complete ? 'Tudo funcionando' : 'Verificação ao vivo',
  }
}

const TITLES: Record<StepKey, string> = {
  credentials: 'Credenciais do aplicativo Telegram',
  login: 'Conta do Telegram',
  bot: 'Bot de alertas',
  groups: 'Grupos para monitorar',
  rule: 'Primeira regra',
  done: 'Tudo pronto?',
}

const ORDER: StepKey[] = ['credentials', 'login', 'bot', 'groups', 'rule', 'done']

export function ConfiguracaoPage() {
  const { csrfToken } = useAuth()
  const { status, loading, error, unavailable, refresh, apply } = useSetupStatus(POLL_MS)
  // The user's own choice of step; `null` follows the server (the next pending step).
  const [chosen, setChosen] = useState<StepKey | 'none' | null>(null)

  const handleStatus = (next: SetupStatus, key: StepKey, stay = false) => {
    apply(next)
    // Move on to whatever the server says comes next, unless the step asked to stay.
    setChosen(stay ? key : null)
  }

  return (
    <main className="setup-page">
      <div className="setup-page__header">
        <h1>Configuração do Telegram</h1>
        <p className="setup-page__subtitle">
          Conecte o teleyes ao Telegram em poucos passos, sem editar arquivos. Pode fechar a página e voltar:
          o assistente continua de onde parou.
        </p>
      </div>

      {loading && <p>Carregando…</p>}
      {unavailable === 'demo' && (
        <p className="setup-note" role="status">
          O assistente de configuração fica desativado na demonstração: nada aqui se conecta ao Telegram.
        </p>
      )}
      {unavailable === 'missing' && (
        <p role="alert" className="setup-error">
          Esta versão do servidor não tem o assistente de configuração. Atualize o teleyes.
        </p>
      )}
      {error !== null && status === null && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}

      {status !== null && unavailable === null && (
        <ol className="setup-steps">
          {ORDER.map((key, index) => {
            const states = stepStates(status)
            const open = (chosen ?? currentStep(status.next_step)) === key
            const common = { status, csrfToken, onStatus: (next: SetupStatus, options?: { stay?: boolean }) => handleStatus(next, key, options?.stay), onRefresh: refresh }
            return (
              <li key={key}>
                <StepCard
                  number={index + 1}
                  title={TITLES[key]}
                  summary={summaries(status)[key]}
                  state={states[key]}
                  open={open}
                  onToggle={() => setChosen(open ? 'none' : key)}
                >
                  {key === 'credentials' && <CredentialsStep {...common} />}
                  {key === 'login' && <LoginStep {...common} />}
                  {key === 'bot' && <BotStep {...common} />}
                  {key === 'groups' && <GroupsStep {...common} />}
                  {key === 'rule' && <RuleStep {...common} />}
                  {key === 'done' && <DoneStep status={status} />}
                </StepCard>
              </li>
            )
          })}
        </ol>
      )}
    </main>
  )
}
