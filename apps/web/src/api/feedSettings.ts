import { apiRequest, jsonHeaders } from './http'
import type { FeedSettings } from './types'

/** S14-05 (F5): `GET/PUT /settings/feed` — the "Agrupar duplicatas" toggle. */
export const fetchFeedSettings = (): Promise<FeedSettings> => apiRequest<FeedSettings>('/settings/feed')

export const updateFeedSettings = (csrfToken: string, groupDuplicates: boolean): Promise<FeedSettings> =>
  apiRequest<FeedSettings>('/settings/feed', {
    method: 'PUT',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify({ group_duplicates: groupDuplicates }),
  })
