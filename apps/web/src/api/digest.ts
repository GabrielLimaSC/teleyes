import { apiRequest, jsonHeaders } from './http'
import type { DigestSettings } from './types'

export type DigestSettingsInput = Pick<
  DigestSettings,
  'enabled' | 'send_at_local' | 'top_n' | 'mute_individual'
>

export const fetchDigestSettings = (): Promise<DigestSettings> =>
  apiRequest<DigestSettings>('/digest')

export const updateDigestSettings = (
  csrfToken: string,
  input: DigestSettingsInput,
): Promise<DigestSettings> =>
  apiRequest<DigestSettings>('/digest', {
    method: 'PUT',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(input),
  })
