import { apiRequest, jsonHeaders } from './http'

/** S13-06: what the panel knows about the listener's "Aplicar regras" mailbox. */
export type ListenerState = 'idle' | 'pending' | 'applying' | 'failed'

/** S25-F4: one thing that differs from what the listener runs. */
export interface UnappliedChange {
  entity: 'rule' | 'source' | 'recipient'
  action: 'created' | 'activated' | 'edited' | 'paused' | 'deleted'
  name: string
  /** Only for `edited`: terms | max_price | target_price | chat. */
  fields: string[]
}

export interface ListenerStatus {
  state: ListenerState
  reload_requested_at: string | null
  reload_applied_at: string | null
  sources_loaded: number | null
  rules_loaded: number | null
  recipients_loaded: number | null
  /** New matches the last apply found in the history window (never alerted). */
  new_matches: number | null
  /** Sources whose history scan did not finish (the configuration is live anyway). */
  scan_failures: number | null
  /** Exception class name of the last failure — never a message. */
  error: string | null
  /** An active source/rule/recipient differs from what the listener loaded. */
  has_unapplied_changes: boolean
  /** What differs, by name. Empty when unknown: show the generic notice. */
  unapplied_changes?: UnappliedChange[]
  listener_online: boolean
  listener_seen_at: string | null
}

export const fetchListenerStatus = (): Promise<ListenerStatus> =>
  apiRequest<ListenerStatus>('/listener/status')

/** Records a request the listener picks up by polling; answers 202 with the status. */
export const requestListenerReload = (csrfToken: string): Promise<ListenerStatus> =>
  apiRequest<ListenerStatus>('/listener/reload', {
    method: 'POST',
    headers: jsonHeaders(csrfToken),
  })
