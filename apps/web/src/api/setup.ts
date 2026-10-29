import { apiRequest, jsonHeaders } from './http'

/**
 * S19-02: client of the first-run wizard API (`/setup/*`, see
 * docs/SECURITY_SETUP.md). Nothing here ever receives a secret back: the server
 * answers with flags, the bot's public username and a masked phone hint. The
 * secrets only travel one way, from the form to the server, and the components
 * clear their fields as soon as the call returns.
 */

export type CredentialSource = 'env' | 'wizard'
export type LoginState = 'none' | 'awaiting_code' | 'awaiting_password' | 'authorized'
export type SetupStepId = 'credentials' | 'login' | 'bot' | 'recipient' | 'groups' | 'rule' | 'done'

export interface SetupStatus {
  credentials: { configured: boolean; source: CredentialSource | null }
  login: { state: LoginState; phone_hint?: string | null; expires_in_seconds?: number | null }
  bot: {
    configured: boolean
    source: CredentialSource | null
    username: string | null
    pairing_active: boolean
    pairing_expires_in_seconds: number | null
  }
  recipients: number
  sources: number
  rules: number
  listener_online: boolean
  steps: {
    credentials: boolean
    login: boolean
    bot: boolean
    recipient: boolean
    groups: boolean
    rule: boolean
  }
  next_step: SetupStepId
  /** API credentials, Telegram session and bot token are all in place. */
  configured: boolean
  /** Every step done and the listener alive. */
  complete: boolean
  events: { kind: string; detail: string | null; created_at: string }[]
}

export interface Pairing {
  code: string
  deep_link: string
  bot_username: string
  expires_in_seconds: number
}

export interface PairingPoll {
  state: 'waiting' | 'paired' | 'expired'
  recipient?: { id: number; name: string } | null
  ignored_starts: number
}

export type GroupsState = 'idle' | 'waiting_listener' | 'pending' | 'running' | 'done' | 'failed'

export interface Dialog {
  chat_id: string
  title: string
  kind: 'group' | 'channel'
  monitored: boolean
}

export interface Groups {
  state: GroupsState
  error: string | null
  dialogs: Dialog[]
}

const post = <T>(path: string, csrfToken: string, body: unknown = {}): Promise<T> =>
  apiRequest<T>(path, { method: 'POST', headers: jsonHeaders(csrfToken), body: JSON.stringify(body) })

export const fetchSetupStatus = (): Promise<SetupStatus> => apiRequest<SetupStatus>('/setup/status')

export const saveCredentials = (csrfToken: string, apiId: number, apiHash: string): Promise<SetupStatus> =>
  apiRequest<SetupStatus>('/setup/credentials', {
    method: 'PUT',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify({ api_id: apiId, api_hash: apiHash }),
  })

export const startLogin = (csrfToken: string, phone: string): Promise<SetupStatus> =>
  post('/setup/telegram/login/start', csrfToken, { phone })

export const submitLoginCode = (csrfToken: string, code: string): Promise<SetupStatus> =>
  post('/setup/telegram/login/code', csrfToken, { code })

export const submitLoginPassword = (csrfToken: string, password: string): Promise<SetupStatus> =>
  post('/setup/telegram/login/password', csrfToken, { password })

export const cancelLogin = (csrfToken: string): Promise<SetupStatus> =>
  post('/setup/telegram/login/cancel', csrfToken)

export const disconnectTelegram = (csrfToken: string): Promise<SetupStatus> =>
  post('/setup/telegram/disconnect', csrfToken, { confirm: true })

export const saveBotToken = (csrfToken: string, token: string): Promise<SetupStatus> =>
  apiRequest<SetupStatus>('/setup/bot', {
    method: 'PUT',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify({ token }),
  })

export const startPairing = (csrfToken: string): Promise<Pairing> => post('/setup/bot/pairing', csrfToken)

export const pollPairing = (csrfToken: string): Promise<PairingPoll> =>
  post('/setup/bot/pairing/poll', csrfToken)

export const fetchGroups = (): Promise<Groups> => apiRequest<Groups>('/setup/groups')

export const refreshGroups = (csrfToken: string): Promise<Groups> => post('/setup/groups/refresh', csrfToken)

export const selectGroups = (
  csrfToken: string,
  chatIds: string[],
): Promise<{ created: number; already_monitored: number }> =>
  post('/setup/groups/select', csrfToken, { chat_ids: chatIds })
