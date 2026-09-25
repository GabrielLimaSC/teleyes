import { apiRequest, jsonHeaders } from './http'
import type { DigestSettings } from './types'

/** S14-04 (F4): `GET/PUT /digest` — the sidebar's "Digest diário" widget. */
export const fetchDigest = (): Promise<DigestSettings> => apiRequest<DigestSettings>('/digest')

export interface DigestUpdateInput {
  enabled: boolean
  sendAtLocal: string
  topN: number
  muteIndividual: boolean
}

export const updateDigest = (csrfToken: string, input: DigestUpdateInput): Promise<DigestSettings> =>
  apiRequest<DigestSettings>('/digest', {
    method: 'PUT',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify({
      enabled: input.enabled,
      send_at_local: input.sendAtLocal,
      top_n: input.topN,
      mute_individual: input.muteIndividual,
    }),
  })
