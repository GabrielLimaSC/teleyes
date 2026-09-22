import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listenerStatus } from '../test/listenerFixtures'
import { RegrasPage } from './RegrasPage'

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    status: 'authenticated',
    adminId: 1,
    csrfMissing: false,
    csrfToken: 'test-csrf',
    login: vi.fn(),
    logout: vi.fn(),
  }),
}))

const baseRule = {
  id: 1,
  name: 'iPhone',
  include_terms: 'iphone',
  exclude_terms: null,
  max_price_cents: 400_000,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
  lowest_price_cents: null,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

/**
 * `RegrasPage` renders more than the rules list on its own: `DestinatariosSection`
 * (S7-01) answers `GET /recipients`, and the "Como uma regra casa" panel
 * (S11-05) calls `GET /metrics` and an unfiltered `GET /matches`, and the
 * "Aplicar regras" panel (S13-06) polls `GET /listener/status`. Every test
 * here has to answer those too — otherwise it either throws on an unhandled
 * URL or, worse, silently reuses the rules mock data as if it were a
 * recipient/metric/match row (a rule named "iPhone" becomes a fake "ativa"
 * recipient, breaking `getByRole('button', { name: 'ativa' })` uniqueness).
 * They answer empty here, except a `GET /matches?rule_id=…` (the S10-04 clear
 * check) which goes to the test's own handler; the stats panel has its own
 * tests below with real numbers.
 */
function withEmptyRecipients(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
    if (url.startsWith('/listener/status')) return Promise.resolve(jsonResponse(listenerStatus()))
    if (url.startsWith('/metrics')) return Promise.resolve(jsonResponse([]))
    if (url.startsWith('/matches') && !url.includes('rule_id=') && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(jsonResponse([]))
    }
    return handler(input, init)
  }
}

describe('RegrasPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists rules with their terms, price limit and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([baseRule])))),
    )

    render(<RegrasPage />)

    expect(await screen.findByText('iPhone')).toBeInTheDocument()
    expect(screen.getByText('R$ 4.000,00')).toBeInTheDocument()
    expect(screen.getByText('ativa')).toBeInTheDocument()
    // baseRule has no priced match yet — falls back to "—", not "R$ 0,00".
    // "Termos bloqueados" also renders "—" for a null exclude_terms, so this
    // targets the specific cell by its data-label instead of the bare text.
    const row = screen.getByText('iPhone').closest('tr') as HTMLElement
    expect(row.querySelector('[data-label="Menor preço já visto"]')).toHaveTextContent('—')
  })

  it('shows the real rule count as the page subtitle (S10-07, moved to the header in S11-05)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([baseRule, { ...baseRule, id: 2, name: 'RTX 5070' }])))),
    )

    render(<RegrasPage />)

    expect(await screen.findByText('2 regras · ações disponíveis em cada linha')).toBeInTheDocument()
  })

  it('the subtitle count uses the singular for exactly one rule (S10-07)', async () => {
    vi.stubGlobal('fetch', vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([baseRule])))))

    render(<RegrasPage />)

    expect(await screen.findByText('1 regra · ações disponíveis em cada linha')).toBeInTheDocument()
  })

  it('shows the Destinatários section header with its subtitle (S10-07)', async () => {
    vi.stubGlobal('fetch', vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([])))))

    render(<RegrasPage />)

    expect(await screen.findByRole('heading', { name: 'Destinatários' })).toBeInTheDocument()
    expect(screen.getByText('Quem recebe os alertas')).toBeInTheDocument()
  })

  it('shows the real lowest price ever seen for a rule with a priced match (S7-06)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        withEmptyRecipients(() =>
          Promise.resolve(jsonResponse([{ ...baseRule, lowest_price_cents: 199_00 }])),
        ),
      ),
    )

    render(<RegrasPage />)

    expect(await screen.findByText('iPhone')).toBeInTheDocument()
    expect(screen.getByText('R$ 199,00')).toBeInTheDocument()
  })

  it('creates a rule and shows the API validation error on failure', async () => {
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET') return Promise.resolve(jsonResponse([]))
        if (method === 'POST') {
          return Promise.resolve(jsonResponse({ detail: 'name must not be blank' }, 422))
        }
        throw new Error(`unexpected ${method} ${String(input)}`)
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    // S11-05: the creation form is a permanent rail — no "+ Nova regra" click
    // needed before typing.
    await user.type(await screen.findByLabelText(/Nome/), ' ')
    await user.type(screen.getByLabelText(/Termos incluídos/), 'termo')
    await user.click(screen.getByRole('button', { name: 'Criar regra' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('name must not be blank')
  })

  it('blocks a rule with no include terms before calling the API (S11-05)', async () => {
    const fetchMock = vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([]))))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.type(await screen.findByLabelText(/Nome/), 'Sem termo')
    await user.click(screen.getByRole('button', { name: 'Criar regra' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Informe ao menos um termo incluído.')
    expect(fetchMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'POST' }))
  })

  it('duplicating a rule pre-fills the create form with a copy suffix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([baseRule])))),
    )
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Duplicar' }))

    expect(screen.getByRole('heading', { name: 'Nova regra' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Nome/)).toHaveValue('iPhone (cópia)')
    // S11-05: the terms load as chips, not as text in an input.
    expect(screen.getByRole('button', { name: 'Remover termo iphone' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Termos incluídos/)).toHaveValue('')
  })

  it('the rule tester previews a sample message locally, with no network call of its own', async () => {
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/rules/test' && method === 'POST') {
          return Promise.resolve(jsonResponse({ total_matched: 0, window_days: 15, messages: [] }))
        }
        return Promise.resolve(jsonResponse([baseRule]))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)
    const row = (await screen.findByText('iPhone')).closest('tr') as HTMLElement

    // S13-07: opening the panel auto-loads the real-history section below —
    // wait for it before counting calls, so that one is accounted for.
    await user.click(within(row).getByRole('button', { name: 'Testar' }))
    await screen.findByText(/Nenhuma promoção já capturada e salva bateu/)
    const callsAfterOpen = fetchMock.mock.calls.length

    await user.type(screen.getByLabelText('Mensagem de exemplo'), 'Promoção iPhone 15')

    expect(await screen.findByText('✅ Bateria com esta regra')).toBeInTheDocument()
    // Typing the local sample message never calls the network — only
    // opening/"Atualizar" does (S13-07's own dry-run half of the panel).
    expect(fetchMock.mock.calls.length).toBe(callsAfterOpen)
  })

  it('S13-07: the real-history section shows real recent matches for the tested terms', async () => {
    let testRequestBody: Record<string, unknown> | null = null
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/rules/test' && method === 'POST') {
          testRequestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return Promise.resolve(
            jsonResponse({
              total_matched: 1,
              window_days: 15,
              messages: [
                {
                  source_id: 1,
                  source_name: 'Grupo Teste',
                  message_text: 'Promoção iPhone 15 por R$ 3.899',
                  price_cents: 389900,
                  price_cash_cents: null,
                  price_card_cents: null,
                  message_link: 'https://t.me/grupo/123',
                  matched_at: '2026-09-20T12:00:00Z',
                  matched_term: 'iphone',
                },
              ],
            }),
          )
        }
        return Promise.resolve(jsonResponse([baseRule]))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)
    const row = (await screen.findByText('iPhone')).closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Testar' }))

    expect(await screen.findByText('Promoção iPhone 15 por R$ 3.899')).toBeInTheDocument()
    expect(screen.getByText(/Grupo Teste/)).toBeInTheDocument()
    expect(screen.getByText('Termo: "iphone"')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Promoções já salvas que bateriam' })).toBeInTheDocument()
    expect(
      screen.getByText(/Mensagens descartadas não ficam armazenadas.*não é uma varredura completa do Telegram/),
    ).toBeInTheDocument()
    expect(screen.getByText(/1 promoção já salva bateria com esses termos/)).toBeInTheDocument()
    expect(testRequestBody).toEqual({
      include_terms: 'iphone',
      exclude_terms: null,
      max_price_cents: 400_000,
    })
  })

  it('S13-07: editing the rule tests the live unsaved fields, not the last-saved ones', async () => {
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/rules/test' && method === 'POST') {
          return Promise.resolve(jsonResponse({ total_matched: 0, window_days: 15, messages: [] }))
        }
        return Promise.resolve(jsonResponse([baseRule]))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)
    const row = (await screen.findByText('iPhone')).closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Editar' }))
    await user.type(screen.getByLabelText(/Termos incluídos/), 'iphone 16{Enter}')

    let testRequestBody: Record<string, unknown> | null = null
    fetchMock.mockImplementation(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/rules/test' && method === 'POST') {
          testRequestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return Promise.resolve(jsonResponse({ total_matched: 0, window_days: 15, messages: [] }))
        }
        return Promise.resolve(jsonResponse([baseRule]))
      }),
    )
    await user.click(within(row).getByRole('button', { name: 'Testar' }))

    await waitFor(() => expect(testRequestBody).not.toBeNull())
    expect(testRequestBody).toMatchObject({ include_terms: 'iphone, iphone 16' })
    expect(screen.getByText(/campos ainda não salvos/)).toBeInTheDocument()
  })

  it('S13-07: "Testar" on the still-unsaved "Nova regra" form tests exactly what is typed', async () => {
    let testRequestBody: Record<string, unknown> | null = null
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/rules/test' && method === 'POST') {
          testRequestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return Promise.resolve(jsonResponse({ total_matched: 0, window_days: 15, messages: [] }))
        }
        return Promise.resolve(jsonResponse([]))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)
    await user.type(await screen.findByLabelText(/Termos incluídos/), 'rtx 5070{Enter}')
    await user.click(screen.getByRole('button', { name: 'Testar' }))

    await waitFor(() => expect(testRequestBody).not.toBeNull())
    expect(testRequestBody).toEqual({ include_terms: 'rtx 5070', exclude_terms: null, max_price_cents: null })
    expect(
      await screen.findByText(
        /Nenhuma promoção já capturada e salva bateu com esses termos nos últimos 15 dias/,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/somente promoções já capturadas e salvas como match/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Testar regra: nova regra (ainda não salva)' })).toBeInTheDocument()
  })

  it('S13-07: blocks testing with no include term, same message as saving', async () => {
    const fetchMock = vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([]))))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)
    await user.click(await screen.findByRole('button', { name: 'Testar' }))

    expect(await screen.findByText('Informe ao menos um termo incluído.')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith('/rules/test', expect.anything())
  })

  it('S13-07: a failed dry-run shows a readable error, not a raw failure', async () => {
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/rules/test' && method === 'POST') {
          return Promise.resolve(new Response('boom', { status: 500 }))
        }
        return Promise.resolve(jsonResponse([baseRule]))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)
    const row = (await screen.findByText('iPhone')).closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Testar' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Erro inesperado (500).')
  })

  it('S13-07: never calls the API repeatedly on its own — only "Testar"/"Atualizar" do', async () => {
    let testCalls = 0
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/rules/test' && method === 'POST') {
          testCalls += 1
          return Promise.resolve(jsonResponse({ total_matched: 0, window_days: 15, messages: [] }))
        }
        return Promise.resolve(jsonResponse([baseRule]))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)
    const row = (await screen.findByText('iPhone')).closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Testar' }))
    await screen.findByText(/Nenhuma promoção já capturada e salva bateu/)
    expect(testCalls).toBe(1)

    await user.click(screen.getByRole('button', { name: 'Atualizar' }))
    await waitFor(() => expect(testCalls).toBe(2))

    await user.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(testCalls).toBe(2)
  })

  it('S13-07: an older response cannot overwrite the tester after switching rules', async () => {
    const ruleA = { ...baseRule, id: 1, name: 'Regra A', include_terms: 'alpha' }
    const ruleB = { ...baseRule, id: 2, name: 'Regra B', include_terms: 'beta' }
    const pendingRequests: Array<ReturnType<typeof deferred<Response>>> = []
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/rules/test' && method === 'POST') {
          const request = deferred<Response>()
          pendingRequests.push(request)
          return request.promise
        }
        return Promise.resolve(jsonResponse([ruleA, ruleB]))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)
    const rowA = (await screen.findByText('Regra A')).closest('tr') as HTMLElement
    const rowB = screen.getByText('Regra B').closest('tr') as HTMLElement

    await user.click(within(rowA).getByRole('button', { name: 'Testar' }))
    await waitFor(() => expect(pendingRequests).toHaveLength(1))
    await user.click(within(rowB).getByRole('button', { name: 'Testar' }))
    await waitFor(() => expect(pendingRequests).toHaveLength(2))

    await act(async () => {
      pendingRequests[1].resolve(
        jsonResponse({
          total_matched: 1,
          window_days: 15,
          messages: [
            {
              source_id: 1,
              source_name: 'Grupo B',
              message_text: 'Resultado correto da regra B',
              price_cents: null,
              price_cash_cents: null,
              price_card_cents: null,
              message_link: null,
              matched_at: '2026-09-22T12:00:00Z',
              matched_term: 'beta',
            },
          ],
        }),
      )
    })
    expect(await screen.findByText('Resultado correto da regra B')).toBeInTheDocument()

    await act(async () => {
      pendingRequests[0].resolve(
        jsonResponse({
          total_matched: 1,
          window_days: 15,
          messages: [
            {
              source_id: 1,
              source_name: 'Grupo A',
              message_text: 'Resultado obsoleto da regra A',
              price_cents: null,
              price_cash_cents: null,
              price_card_cents: null,
              message_link: null,
              matched_at: '2026-09-22T11:00:00Z',
              matched_term: 'alpha',
            },
          ],
        }),
      )
    })

    expect(screen.getByRole('heading', { name: 'Testar regra: Regra B' })).toBeInTheDocument()
    expect(screen.getByText('Resultado correto da regra B')).toBeInTheDocument()
    expect(screen.queryByText('Resultado obsoleto da regra A')).not.toBeInTheDocument()
  })

  it('S13-07: a response arriving after the tester closes stays hidden', async () => {
    const pendingRequest = deferred<Response>()
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        if (String(input) === '/rules/test' && (init?.method ?? 'GET') === 'POST') {
          return pendingRequest.promise
        }
        return Promise.resolve(jsonResponse([baseRule]))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)
    const row = (await screen.findByText('iPhone')).closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Testar' }))
    expect(await screen.findByRole('heading', { name: 'Testar regra: iPhone' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Fechar' }))

    await act(async () => {
      pendingRequest.resolve(
        jsonResponse({
          total_matched: 1,
          window_days: 15,
          messages: [
            {
              source_id: 1,
              source_name: 'Grupo atrasado',
              message_text: 'Resultado depois de fechar',
              price_cents: null,
              price_cash_cents: null,
              price_card_cents: null,
              message_link: null,
              matched_at: '2026-09-22T12:00:00Z',
              matched_term: 'iphone',
            },
          ],
        }),
      )
    })

    expect(screen.queryByRole('heading', { name: 'Testar regra: iPhone' })).not.toBeInTheDocument()
    expect(screen.queryByText('Resultado depois de fechar')).not.toBeInTheDocument()
  })

  it('pausing a rule calls the pause endpoint and reloads the list', async () => {
    const paused = { ...baseRule, active: false }
    let pauseCalled = false
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.endsWith('/pause')) {
          pauseCalled = true
          return Promise.resolve(jsonResponse(paused))
        }
        if (method === 'GET') return Promise.resolve(jsonResponse(pauseCalled ? [paused] : [baseRule]))
        throw new Error(`unexpected ${method} ${url}`)
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'ativa' }))

    expect(await screen.findByRole('button', { name: 'pausada' })).toBeInTheDocument()
    // S9-02: pausing had no success feedback at all before this — the S7-11
    // status toggle change itself is evidence enough of success on its own,
    // but the toast confirms the gap the task set out to fill is covered.
    expect(await screen.findByRole('status')).toHaveTextContent('Regra pausada.')
  })

  it('creating a rule shows a success toast (S9-02)', async () => {
    let created = false
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'POST') {
          created = true
          return Promise.resolve(jsonResponse({ ...baseRule, id: 2, name: 'Nova regra' }, 201))
        }
        if (method === 'GET') return Promise.resolve(jsonResponse(created ? [baseRule, { ...baseRule, id: 2, name: 'Nova regra' }] : [baseRule]))
        throw new Error(`unexpected ${method} ${String(input)}`)
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.type(await screen.findByLabelText(/Nome/), 'Nova regra')
    await user.type(screen.getByLabelText(/Termos incluídos/), 'novo termo')
    await user.click(screen.getByRole('button', { name: 'Criar regra' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Regra criada.')
  })

  it('updating a rule shows a distinct success toast from creating (S9-02)', async () => {
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'PATCH') return Promise.resolve(jsonResponse({ ...baseRule, name: 'iPhone editado' }))
        if (method === 'GET') return Promise.resolve(jsonResponse([baseRule]))
        throw new Error(`unexpected ${method} ${String(input)}`)
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Editar' }))
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Regra atualizada.')
  })

  it('deleting a rule shows a success toast (S9-02)', async () => {
    let deleted = false
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (method === 'DELETE') {
          deleted = true
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        if (method === 'GET') return Promise.resolve(jsonResponse(deleted ? [] : [baseRule]))
        throw new Error(`unexpected ${method} ${url}`)
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Excluir' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Regra excluída.')
  })

  it('clearing a rule history shows a confirmation with the real match count first (S10-04)', async () => {
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.startsWith('/matches')) {
          return Promise.resolve(jsonResponse([{ id: 1 }, { id: 2 }, { id: 3 }]))
        }
        if (method === 'GET') return Promise.resolve(jsonResponse([baseRule]))
        throw new Error(`unexpected ${method} ${url}`)
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Limpar histórico' }))

    expect(await screen.findByRole('heading', { name: 'Limpar histórico: iPhone' })).toBeInTheDocument()
    expect(screen.getByText(/apaga 3 matches desta/)).toBeInTheDocument()
    // Only checked the count so far — never called the destructive endpoint.
    expect(fetchMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'DELETE' }))
  })

  it('confirming clears the rule history and shows the real deleted count (S10-04)', async () => {
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (method === 'DELETE' && url.includes('/matches')) {
          return Promise.resolve(jsonResponse({ deleted: 3 }))
        }
        if (method === 'GET' && url.startsWith('/matches')) {
          return Promise.resolve(jsonResponse([{ id: 1 }, { id: 2 }, { id: 3 }]))
        }
        if (method === 'GET') return Promise.resolve(jsonResponse([baseRule]))
        throw new Error(`unexpected ${method} ${url}`)
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Limpar histórico' }))
    await user.click(await screen.findByRole('button', { name: 'Apagar histórico' }))

    expect(await screen.findByRole('status')).toHaveTextContent('3 matches apagados.')
    expect(screen.queryByRole('heading', { name: 'Limpar histórico: iPhone' })).not.toBeInTheDocument()
  })

  it('shows a toast directly, no confirmation, when the rule has no matches to clear (S10-04)', async () => {
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.startsWith('/matches')) return Promise.resolve(jsonResponse([]))
        if (method === 'GET') return Promise.resolve(jsonResponse([baseRule]))
        throw new Error(`unexpected ${method} ${url}`)
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Limpar histórico' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Nenhum match encontrado')
    expect(screen.queryByRole('heading', { name: 'Limpar histórico: iPhone' })).not.toBeInTheDocument()
  })

  it('canceling the clear confirmation calls no destructive endpoint (S10-04)', async () => {
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.startsWith('/matches')) return Promise.resolve(jsonResponse([{ id: 1 }]))
        if (method === 'GET') return Promise.resolve(jsonResponse([baseRule]))
        throw new Error(`unexpected ${method} ${url}`)
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Limpar histórico' }))
    await screen.findByRole('heading', { name: 'Limpar histórico: iPhone' })
    await user.click(screen.getByRole('button', { name: 'Cancelar' }))

    expect(screen.queryByRole('heading', { name: 'Limpar histórico: iPhone' })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'DELETE' }))
  })

  it('creates a rule from chips and sends include_terms as the comma-separated string (S11-05)', async () => {
    let postedBody: Record<string, unknown> | null = null
    const fetchMock = vi.fn(
      withEmptyRecipients((_input, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'POST') {
          postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return Promise.resolve(jsonResponse({ ...baseRule, id: 2 }, 201))
        }
        return Promise.resolve(jsonResponse([]))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.type(await screen.findByLabelText(/Nome/), 'Monitor')
    const terms = screen.getByLabelText(/Termos incluídos/)
    await user.type(terms, 'monitor 27{Enter}165hz,')
    // Still typed (no Enter/comma) when the button is clicked: not lost.
    await user.type(terms, 'ips')
    await user.type(screen.getByLabelText('Termos bloqueados'), 'usado')
    await user.type(screen.getByLabelText(/Preço máximo/), '1500')
    await user.click(screen.getByRole('button', { name: 'Criar regra' }))

    await waitFor(() => expect(postedBody).not.toBeNull())
    expect(postedBody).toEqual({
      name: 'Monitor',
      include_terms: 'monitor 27, 165hz, ips',
      exclude_terms: 'usado',
      max_price_cents: 150_000,
    })
  })

  it('editing a rule loads its terms as chips; removing one saves the shorter string (S11-05)', async () => {
    let patchedBody: Record<string, unknown> | null = null
    const fetchMock = vi.fn(
      withEmptyRecipients((_input, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'PATCH') {
          patchedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return Promise.resolve(jsonResponse(baseRule))
        }
        return Promise.resolve(jsonResponse([{ ...baseRule, include_terms: 'iphone 15,iphone 16' }]))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Editar' }))
    expect(screen.getByRole('heading', { name: 'Editar regra' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remover termo iphone 15' }))
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))

    await waitFor(() => expect(patchedBody).not.toBeNull())
    expect(patchedBody).toMatchObject({ include_terms: 'iphone 16' })
  })

  it('shows the real cumulative stats in the "Como uma regra casa" panel (S11-05)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/listener/status')) return Promise.resolve(jsonResponse(listenerStatus()))
        if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([{ id: 1 }, { id: 2 }, { id: 3 }]))
        if (url.startsWith('/metrics')) {
          return Promise.resolve(
            jsonResponse([
              { source_id: 1, reason: 'preco_acima_teto', count: 4, updated_at: '2026-01-01T00:00:00Z' },
              { source_id: 2, reason: 'preco_acima_teto', count: 5, updated_at: '2026-01-01T00:00:00Z' },
              { source_id: 1, reason: 'vista', count: 100, updated_at: '2026-01-01T00:00:00Z' },
              { source_id: 1, reason: 'bloqueado', count: 7, updated_at: '2026-01-01T00:00:00Z' },
            ]),
          )
        }
        return Promise.resolve(jsonResponse([baseRule]))
      }),
    )

    render(<RegrasPage />)

    const panel = (await screen.findByRole('heading', { name: 'Como uma regra casa' })).closest('section') as HTMLElement
    await waitFor(() => expect(within(panel).getByText('Casaram').nextElementSibling).toHaveTextContent('3'))
    // Only preco_acima_teto, summed across sources: 4 + 5 — not "vista"/"bloqueado".
    expect(within(panel).getByText('Descartadas por teto').nextElementSibling).toHaveTextContent('9')
    // Honest label: cumulative, not "hoje".
    expect(within(panel).getByText(/acumulados.*não são do dia/)).toBeInTheDocument()
    expect(within(panel).queryByText(/hoje/i)).not.toBeInTheDocument()
  })

  it('shows "—" instead of a made-up number when the stats cannot load (S11-05)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/listener/status')) return Promise.resolve(jsonResponse(listenerStatus()))
        if (url.startsWith('/matches') || url.startsWith('/metrics')) {
          return Promise.resolve(new Response('boom', { status: 500 }))
        }
        return Promise.resolve(jsonResponse([baseRule]))
      }),
    )

    render(<RegrasPage />)

    const panel = (await screen.findByRole('heading', { name: 'Como uma regra casa' })).closest('section') as HTMLElement
    await waitFor(() => expect(within(panel).getByText('Casaram').nextElementSibling).toHaveTextContent('—'))
    expect(within(panel).getByText('Descartadas por teto').nextElementSibling).toHaveTextContent('—')
  })

  it('explains matching the way the backend really works: any include term, not all (S11-05)', async () => {
    vi.stubGlobal('fetch', vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([])))))

    render(<RegrasPage />)

    expect(await screen.findByText(/Basta um dos termos incluídos/)).toBeInTheDocument()
  })

  it('keeps "Limpar histórico" on every row and does not offer "Testar todas" (S11-05)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([baseRule, { ...baseRule, id: 2, name: 'RTX' }])))),
    )

    render(<RegrasPage />)

    expect(await screen.findAllByRole('button', { name: 'Limpar histórico' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Testar todas/ })).not.toBeInTheDocument()
  })

  it('"+ Nova regra" resets an edit in progress back to an empty creation form (S11-05)', async () => {
    vi.stubGlobal('fetch', vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([baseRule])))))
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Editar' }))
    expect(screen.getByLabelText(/Nome/)).toHaveValue('iPhone')

    await user.click(screen.getByRole('button', { name: '+ Nova regra' }))

    expect(screen.getByRole('heading', { name: 'Nova regra' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Nome/)).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Remover termo iphone' })).not.toBeInTheDocument()
  })
})

/**
 * S13-06: the "Aplicar regras" panel. `statuses` is what `GET /listener/status`
 * answers, in order (the last one repeats); a POST to `/listener/reload` records
 * the request headers and answers `reloadAnswer`.
 */
function listenerAwareFetch(options: {
  statuses: ReturnType<typeof listenerStatus>[]
  reloadAnswer?: ReturnType<typeof listenerStatus>
  rules?: unknown[]
}) {
  const statuses = [...options.statuses]
  const log: { statusReads: number; reloadHeaders: Record<string, string> | null } = {
    statusReads: 0,
    reloadHeaders: null,
  }
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/listener/reload' && method === 'POST') {
      log.reloadHeaders = init?.headers as Record<string, string>
      return Promise.resolve(jsonResponse(options.reloadAnswer ?? listenerStatus({ state: 'pending' }), 202))
    }
    if (url.startsWith('/listener/status')) {
      log.statusReads += 1
      const next = statuses.length > 1 ? statuses.shift() : statuses[0]
      return Promise.resolve(jsonResponse(next))
    }
    if (url.startsWith('/recipients') || url.startsWith('/metrics')) return Promise.resolve(jsonResponse([]))
    if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([]))
    if (method === 'POST') return Promise.resolve(jsonResponse({ ...baseRule, id: 9, name: 'Nova' }, 201))
    return Promise.resolve(jsonResponse(options.rules ?? [baseRule]))
  })
  return { fetchMock, log }
}

describe('RegrasPage — Aplicar regras (S13-06)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('warns that changes are not applied yet and offers the button', async () => {
    const { fetchMock } = listenerAwareFetch({ statuses: [listenerStatus({ has_unapplied_changes: true })] })
    vi.stubGlobal('fetch', fetchMock)

    render(<RegrasPage />)

    expect(await screen.findByText('Há mudanças ainda não aplicadas')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aplicar regras' })).toBeEnabled()
  })

  it('applying posts with the CSRF token, shows "Aplicando…", then confirms with the history result', async () => {
    const { fetchMock, log } = listenerAwareFetch({
      statuses: [
        listenerStatus({ has_unapplied_changes: true }),
        listenerStatus({ state: 'applying', has_unapplied_changes: true }),
        listenerStatus({ new_matches: 5 }),
      ],
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    render(<RegrasPage />)
    await user.click(await screen.findByRole('button', { name: 'Aplicar regras' }))

    expect(await screen.findByRole('button', { name: 'Aplicando…' })).toBeDisabled()
    expect(log.reloadHeaders?.['X-CSRF-Token']).toBe('test-csrf')

    await vi.advanceTimersByTimeAsync(4000)

    expect(await screen.findByRole('status')).toHaveTextContent('Regras aplicadas — 5 matches novos no histórico.')
    expect(screen.getByText('Regras aplicadas')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aplicar regras' })).toBeEnabled()
  })

  it('a failed apply is announced and the old configuration is said to stay', async () => {
    const { fetchMock } = listenerAwareFetch({
      statuses: [
        listenerStatus({ has_unapplied_changes: true }),
        listenerStatus({ state: 'failed', error: 'ConnectionError', has_unapplied_changes: true }),
      ],
      reloadAnswer: listenerStatus({ state: 'pending', has_unapplied_changes: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    render(<RegrasPage />)
    await user.click(await screen.findByRole('button', { name: 'Aplicar regras' }))
    await vi.advanceTimersByTimeAsync(4000)

    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some((node) => /A configuração anterior continua ativa/.test(node.textContent ?? ''))).toBe(true)
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeEnabled()
  })

  it('creating a rule re-checks what is left to apply right away', async () => {
    const { fetchMock, log } = listenerAwareFetch({ statuses: [listenerStatus()] })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    render(<RegrasPage />)
    await user.type(await screen.findByLabelText(/Nome/), 'Nova')
    await user.type(screen.getByLabelText(/Termos incluídos/), 'termo')
    const readsBefore = log.statusReads
    await user.click(screen.getByRole('button', { name: 'Criar regra' }))

    await waitFor(() => expect(log.statusReads).toBeGreaterThan(readsBefore))
  })
})
