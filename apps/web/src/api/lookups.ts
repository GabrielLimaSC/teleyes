import { ApiError } from './auth'
import type { Recipient, Rule, Source } from './types'

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin' })
  if (!response.ok) {
    throw new ApiError(`Não foi possível carregar ${path}.`, response.status)
  }
  return (await response.json()) as T
}

export const fetchRules = (): Promise<Rule[]> => getJson<Rule[]>('/rules')
export const fetchSources = (): Promise<Source[]> => getJson<Source[]>('/sources')
export const fetchRecipients = (): Promise<Recipient[]> => getJson<Recipient[]>('/recipients')
