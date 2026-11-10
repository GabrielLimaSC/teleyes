import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenerStatus } from '../test/listenerFixtures'
import { RegrasPage } from './RegrasPage'

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    status: 'authenticated',
    adminId: 1,
    csrfToken: 'test-csrf',
    login: vi.fn(),
    logout: vi.fn(),
  }),
}))

function rule(id: number, name: string, recipientIds: number[]) {
  return {
    id,
    name,
    include_terms: name.toLowerCase(),
    exclude_terms: null,
    max_price_cents: 400_000,
    target_price_cents: null,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    lowest_price_cents: null,
    lowest_price_24h_cents: null,
    snoozed_until: null,
    history_30d: [],
    recipient_ids: recipientIds,
  }
}

function recipient(id: number, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    telegram_chat_id: `10${id}`,
    allowlisted: true,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    rules_mode: 'all',
    rule_ids: [],
    notify_target: true,
    notify_common: true,
    ...overrides,
  }
}

const DIGEST = {
  enabled: true,
  send_at_local: '09:00',
  top_n: 5,
  mute_individual: false,
  next_run_at_utc: '2026-09-25T12:00:00Z',
  next_run_at_local: '2026-09-25 09:00',
  queue_count: 0,
  queue: [],
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface Scenario {
  rules: unknown[]
  recipients: unknown[]
  /** Answer for `PATCH /recipients/:id` and `POST /recipients`. */
  write?: (url: string, init: RequestInit) => Response
}

function setup({ rules, recipients, write }: Scenario) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.startsWith('/recipients/preview')) {
      const ids = new URL(url, 'http://x').searchParams.get('rule_ids')
      const chosen = ids ? ids.split(',').map(Number) : (rules as Array<{ id: number }>).map((item) => item.id)
      return Promise.resolve(
        json({ alerts_per_week: chosen.length * 2, per_rule: chosen.map((id) => ({ rule_id: id, per_week: 2 })) }),
      )
    }
    if (url.startsWith('/recipients') && method !== 'GET') {
      return Promise.resolve(write ? write(url, init ?? {}) : json(recipients[0]))
    }
    if (url.startsWith('/recipients')) return Promise.resolve(json(recipients))
    if (url.startsWith('/listener/status')) return Promise.resolve(json(listenerStatus()))
    if (url.startsWith('/metrics') || url.startsWith('/snoozes')) return Promise.resolve(json([]))
    if (url.startsWith('/digest')) return Promise.resolve(json(DIGEST))
    if (url.startsWith('/matches')) return Promise.resolve(json([]))
    return Promise.resolve(json(rules))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls }
}

const previewCalls = (calls: Array<{ url: string }>) => calls.filter((call) => call.url.startsWith('/recipients/preview'))

const RULES = [rule(1, 'iPhone', [1, 2]), rule(2, 'RTX 5070', [1]), rule(3, 'Monitor', [])]

describe('RegrasPage — destinatários por regra (S21-07)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows who receives each rule in the Destinatários column', async () => {
    setup({
      rules: RULES,
      recipients: [recipient(1, 'Alex'), recipient(2, 'Jordan', { rules_mode: 'selected', rule_ids: [1] })],
    })
    render(<RegrasPage />)

    expect(await screen.findByRole('columnheader', { name: 'Destinatários' })).toBeInTheDocument()
    await screen.findByRole('article', { name: 'Destinatário Alex' })
    const rowOf = (id: number) => document.getElementById(`rule-toggle-${id}`)!.closest('tr')!
    expect(within(rowOf(1)).getByText('2 pessoas')).toBeInTheDocument()
    const rtx = rowOf(2)
    expect(within(rtx).getByText('só Alex')).toBeInTheDocument()
    const monitor = rowOf(3)
    expect(within(monitor).getByText('ninguém recebe')).toBeInTheDocument()
  })

  it('warns inside the expanded rule when a chosen-rules recipient does not receive it', async () => {
    setup({
      rules: RULES,
      recipients: [recipient(1, 'Alex'), recipient(2, 'Jordan', { rules_mode: 'selected', rule_ids: [1] })],
    })
    const user = userEvent.setup()
    render(<RegrasPage />)

    await screen.findByRole('article', { name: 'Destinatário Alex' })
    await user.click(document.getElementById('rule-toggle-2')!)
    expect(await screen.findByText('1 destinatário não recebe esta regra')).toBeInTheDocument()
  })

  it('shows the card with mode, chips, delivery lines and the preview summary', async () => {
    const { calls } = setup({
      rules: RULES,
      recipients: [recipient(2, 'Jordan', { rules_mode: 'selected', rule_ids: [1, 2], notify_common: false })],
    })
    render(<RegrasPage />)

    const card = await screen.findByRole('article', { name: 'Destinatário Jordan' })
    expect(within(card).getByRole('button', { name: 'Escolher regras', pressed: true })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'iPhone', pressed: true })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Monitor', pressed: false })).toBeInTheDocument()
    expect(within(card).getByText('ping imediato')).toBeInTheDocument()
    expect(within(card).getByText('desligado')).toBeInTheDocument()
    expect(await within(card).findByText('2 de 3 regras · só preços-alvo atingidos · ~4 alertas/semana')).toBeInTheDocument()
    expect(previewCalls(calls)).toHaveLength(1)
  })

  it('names the digest time for a common match while the digest is on', async () => {
    setup({ rules: RULES, recipients: [recipient(1, 'Alex')] })
    render(<RegrasPage />)

    const card = await screen.findByRole('article', { name: 'Destinatário Alex' })
    expect(within(card).getByText('no resumo diário 09:00')).toBeInTheDocument()
  })

  it('warns "não recebe nada" when choosing rules with none selected', async () => {
    setup({ rules: RULES, recipients: [recipient(1, 'Alex')] })
    const user = userEvent.setup()
    render(<RegrasPage />)

    const card = await screen.findByRole('article', { name: 'Destinatário Alex' })
    await user.click(within(card).getByRole('button', { name: 'Escolher regras' }))
    expect(within(card).getByText(/Não recebe nada/)).toBeInTheDocument()
  })

  it('saves card changes with PATCH and shows the confirmation', async () => {
    const { calls } = setup({
      rules: RULES,
      recipients: [recipient(1, 'Alex')],
      write: () => json(recipient(1, 'Alex')),
    })
    const user = userEvent.setup()
    render(<RegrasPage />)

    const card = await screen.findByRole('article', { name: 'Destinatário Alex' })
    await user.click(within(card).getByRole('button', { name: 'Escolher regras' }))
    await user.click(within(card).getByRole('button', { name: 'iPhone' }))
    await user.click(within(card).getByRole('switch', { name: 'Oferta comum para Alex' }))
    await user.click(within(card).getByRole('button', { name: 'Salvar alterações' }))

    const patch = calls.find((call) => call.method === 'PATCH')
    expect(patch?.url).toBe('/recipients/1')
    expect(patch?.body).toEqual({
      rules_mode: 'selected',
      rule_ids: [1],
      notify_target: true,
      notify_common: false,
    })
    expect(await within(card).findByText('Alterações salvas.')).toBeInTheDocument()
  })

  it('shows the API 422 message on the card', async () => {
    setup({
      rules: RULES,
      recipients: [recipient(1, 'Alex')],
      write: () => json({ detail: 'Escolha pelo menos uma regra para este destinatário.' }, 422),
    })
    const user = userEvent.setup()
    render(<RegrasPage />)

    const card = await screen.findByRole('article', { name: 'Destinatário Alex' })
    await user.click(within(card).getByRole('button', { name: 'Escolher regras' }))
    await user.click(within(card).getByRole('button', { name: 'Salvar alterações' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent(
      'Escolha pelo menos uma regra para este destinatário.',
    )
  })

  it('debounces the card preview while chips are toggled', async () => {
    const { calls } = setup({ rules: RULES, recipients: [recipient(1, 'Alex', { rules_mode: 'selected', rule_ids: [1] })] })
    const user = userEvent.setup()
    render(<RegrasPage />)

    const card = await screen.findByRole('article', { name: 'Destinatário Alex' })
    await within(card).findByText(/alertas\/semana/)
    const before = previewCalls(calls).length
    await user.click(within(card).getByRole('button', { name: 'RTX 5070' }))
    await user.click(within(card).getByRole('button', { name: 'Monitor' }))
    await user.click(within(card).getByRole('button', { name: 'iPhone' }))
    await waitFor(() => expect(previewCalls(calls).length).toBe(before + 1))
    expect(new URL(previewCalls(calls).at(-1)!.url, 'http://x').searchParams.get('rule_ids')).toBe('2,3')
  })

  it('new recipient form: validates, previews and creates with the chosen rules', async () => {
    const { calls } = setup({ rules: RULES, recipients: [], write: () => json(recipient(5, 'Jordan'), 201) })
    const user = userEvent.setup()
    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: '+ Adicionar destinatário' }))
    await user.type(screen.getByLabelText('Nome'), 'Jordan')
    await user.type(screen.getByLabelText('Chat ID do Telegram'), '777')
    expect(screen.getByRole('button', { name: 'Enviar teste' })).toBeDisabled()

    const form = screen.getByRole('button', { name: 'Adicionar' }).closest('form')!
    await user.click(within(form).getByRole('button', { name: 'Escolher regras' }))
    expect(within(form).getByRole('button', { name: 'Adicionar' })).toBeDisabled()
    expect(within(form).getByText('Escolha ao menos uma regra para continuar.')).toBeInTheDocument()

    await user.click(within(form).getByRole('checkbox', { name: 'iPhone' }))
    await user.click(within(form).getByRole('checkbox', { name: 'RTX 5070' }))
    await user.click(within(form).getByRole('switch', { name: 'Oferta comum' }))
    expect(await within(form).findByText(
      'Jordan vai receber 2 regras, só quando o preço-alvo for atingido — cerca de 4 alertas por semana no ritmo atual.',
    )).toBeInTheDocument()
    expect(within(form).getAllByText('2/sem')).toHaveLength(2)

    await user.click(within(form).getByRole('switch', { name: 'Preço-alvo atingido' }))
    expect(within(form).getByText('Ligue ao menos um tipo de alerta para continuar.')).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: 'Adicionar' })).toBeDisabled()
    await user.click(within(form).getByRole('switch', { name: 'Preço-alvo atingido' }))

    await user.click(within(form).getByRole('button', { name: 'Adicionar' }))
    const post = calls.find((call) => call.method === 'POST')
    expect(post?.body).toEqual({
      name: 'Jordan',
      telegram_chat_id: '777',
      allowlisted: true,
      rules_mode: 'selected',
      rule_ids: [1, 2],
      notify_target: true,
      notify_common: false,
    })
  })

  it('new recipient form: shows the API 422 message', async () => {
    setup({ rules: RULES, recipients: [], write: () => json({ detail: 'Regra inexistente: 9.' }, 422) })
    const user = userEvent.setup()
    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: '+ Adicionar destinatário' }))
    await user.type(screen.getByLabelText('Nome'), 'Jordan')
    await user.type(screen.getByLabelText('Chat ID do Telegram'), '777')
    await user.click(screen.getByRole('button', { name: 'Adicionar' }))
    expect(await screen.findByText('Regra inexistente: 9.')).toBeInTheDocument()
  })
})
