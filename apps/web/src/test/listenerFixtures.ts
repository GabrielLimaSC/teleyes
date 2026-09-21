import type { ListenerStatus } from '../api/listener'

/** S13-06: a listener that applied everything a while ago; tests override fields. */
export function listenerStatus(overrides: Partial<ListenerStatus> = {}): ListenerStatus {
  return {
    state: 'idle',
    reload_requested_at: null,
    reload_applied_at: '2026-09-21T17:32:00Z',
    sources_loaded: 2,
    rules_loaded: 6,
    recipients_loaded: 1,
    new_matches: 3,
    scan_failures: 0,
    error: null,
    has_unapplied_changes: false,
    listener_online: true,
    listener_seen_at: '2026-09-21T17:40:00Z',
    ...overrides,
  }
}
