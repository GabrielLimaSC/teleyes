import type { SetupStatus } from '../api/setup'

/** What every step of the wizard receives from the page. */
export interface StepProps {
  status: SetupStatus
  csrfToken: string | null
  /** A mutating call returned a fresh status: adopt it. */
  onStatus: (status: SetupStatus) => void
  /** Something changed outside the wizard's own calls (rules, sources): re-read the status. */
  onRefresh: () => void
}
