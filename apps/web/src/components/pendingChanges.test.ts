import { describe, expect, it } from 'vitest'
import type { UnappliedChange } from '../api/listener'
import { summarizePending } from './pendingChanges'

const change = (overrides: Partial<UnappliedChange>): UnappliedChange => ({
  entity: 'rule',
  action: 'created',
  name: 'SSD NVMe',
  fields: [],
  ...overrides,
})

describe('summarizePending', () => {
  it('names what changed, like the design', () => {
    const summary = summarizePending([
      change({ action: 'edited', name: 'Fone bluetooth', fields: ['target_price'] }),
      change({}),
    ])
    expect(summary.title).toBe('2 mudanças não aplicadas')
    expect(summary.detail).toBe('preço-alvo de Fone bluetooth e nova regra SSD NVMe')
  })

  it('covers pause, removal and several fields', () => {
    const summary = summarizePending([
      change({ action: 'paused', name: 'A' }),
      change({ action: 'deleted', name: 'B' }),
      change({ action: 'edited', name: 'C', fields: ['target_price', 'max_price'] }),
    ])
    expect(summary.detail).toBe('regra A pausada, regra B removida e preço-alvo e preço máximo de C')
  })

  it('collapses the tail and falls back to a generic notice when the detail is unknown', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((name) => change({ name }))
    expect(summarizePending(many).detail).toBe('nova regra a, nova regra b, nova regra c e 2 outras mudanças')
    expect(summarizePending([change({})]).title).toBe('1 mudança não aplicada')
    expect(summarizePending([])).toEqual({ title: 'Há mudanças não aplicadas', detail: '' })
  })
})
