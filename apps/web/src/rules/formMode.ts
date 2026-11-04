/**
 * S23-05: the rule form has a simple mode (what to look for, price ceiling,
 * instant-alert target) and an advanced one (blocked terms and `a + b`
 * explanation). The last choice is a per-viewer convenience kept in
 * localStorage; storage may be blocked, so every access is guarded.
 */
const STORAGE_KEY = 'teleyes.rules.formMode'

export type RuleFormMode = 'simple' | 'advanced'

export function readFormModePreference(): RuleFormMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'advanced' ? 'advanced' : 'simple'
  } catch {
    return 'simple'
  }
}

export function writeFormModePreference(mode: RuleFormMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // Storage blocked: the form still works, it just forgets the choice.
  }
}

/** A rule that already uses blocked terms or `a + b` can only be shown
 * honestly in advanced mode. */
export function usesAdvancedFields(fields: { includeTerms: string; excludeTerms: string }): boolean {
  return fields.excludeTerms.trim() !== '' || fields.includeTerms.includes('+')
}
