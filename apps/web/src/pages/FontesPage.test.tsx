import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FontesPage } from './FontesPage'

vi.mock('../auth/AuthContext', () => ({
  CSRF_MISSING_MESSAGE: 'csrf ausente',
  useAuth: () => ({ csrfToken: 'test-csrf' }),
}))

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

const source = (id: number, name: string, chat: string, active = true) => ({
  id,
  name,
  telegram_chat_id: chat,
  active,
  created_at: '2026-01-01T00:00:00',
})

const days = (values: (number | null)[]) =>
  values.map((evaluated, index) => ({ day: `2026-09-${String(14 + index).padStart(2, '0')}`, evaluated }))

const activityRow = (
  id: number,
  name: string,
  daily: (number | null)[],
  matches: number,
  lastMatchAt: string | null,
) => ({ source_id: id, name, active: true, daily: days(daily), matches, last_match_at: lastMatchAt })

interface Stub {
  sources?: unknown[]
  activity?: unknown
  setupConfigured?: boolean
  groups?: unknown
}

function stubApi({ sources, activity, setupConfigured = false, groups }: Stub) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.startsWith('/sources/activity')) {
        return Promise.resolve(activity === undefined ? new Response('x', { status: 500 }) : jsonResponse(activity))
      }
      if (url.startsWith('/sources')) return Promise.resolve(jsonResponse(sources ?? []))
      if (url === '/setup/status') return Promise.resolve(jsonResponse({ configured: setupConfigured }))
      if (url === '/setup/groups/select') return Promise.resolve(jsonResponse({ created: 2, already_monitored: 0 }))
      if (url.startsWith('/setup/groups')) return Promise.resolve(jsonResponse(groups))
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  return calls
}

function renderPage() {
  return render(
    <MemoryRouter>
      <FontesPage />
    </MemoryRouter>,
  )
}

const FULL_ACTIVITY = {
  days: 7,
  coverage_since: '2026-09-14T00:00:00Z',
  sources: [
    activityRow(1, 'Fonte Alfa', [10, 20, 40, 5, 0, 8, 100], 52, '2026-09-20T01:43:00'),
    activityRow(2, 'Fonte Beta', [null, null, null, 4, 2, 1, 3], 18, null),
  ],
}

describe('FontesPage KPIs (S21-11)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sums the figures and names the leading source', async () => {
    stubApi({ sources: [source(1, 'Fonte Alfa', '-1001'), source(2, 'Fonte Beta', '-1002')], activity: FULL_ACTIVITY })
    renderPage()

    const kpis = (await screen.findByText('Grupos ativos')).closest('dl') as HTMLElement
    expect(within(kpis).getByText('2 de 2')).toBeInTheDocument()
    expect(within(kpis).getByText('nenhuma pausada')).toBeInTheDocument()
    expect(within(kpis).getByText('Mensagens analisadas · hoje')).toBeInTheDocument()
    expect(within(kpis).getByText('103')).toBeInTheDocument() // 100 + 3
    expect(within(kpis).getByText('70')).toBeInTheDocument() // 52 + 18
    expect(within(kpis).getByText('Fonte Alfa lidera')).toBeInTheDocument()
    expect(within(kpis).getByText('Último match')).toBeInTheDocument()
  })

  it('shows "—" and "coletando desde" when nothing was measured', async () => {
    stubApi({
      sources: [source(1, 'Fonte Alfa', '-1001', false)],
      activity: {
        days: 7,
        coverage_since: '2026-09-20T12:00:00Z',
        sources: [activityRow(1, 'Fonte Alfa', [null, null, null, null, null, null, null], 0, null)],
      },
    })
    renderPage()

    const kpis = (await screen.findByText('Grupos ativos')).closest('dl') as HTMLElement
    await within(kpis).findByText('0 de 1')
    expect(within(kpis).getByText('1 pausada')).toBeInTheDocument()
    expect(within(kpis).getByText(/coletando desde/)).toBeInTheDocument()
    expect(within(kpis).getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the table when the activity endpoint fails', async () => {
    stubApi({ sources: [source(1, 'Fonte Alfa', '-1001')] })
    renderPage()

    expect(await screen.findByText('Fonte Alfa')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})

describe('FontesPage table (S21-11)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('draws 7 bars per source and marks unmeasured days as pending', async () => {
    stubApi({ sources: [source(1, 'Fonte Alfa', '-1001'), source(2, 'Fonte Beta', '-1002')], activity: FULL_ACTIVITY })
    renderPage()

    const beta = (await screen.findByRole('row', { name: /Fonte Beta/ }))
    const bars = within(beta).getByRole('img').querySelectorAll('.fontes-bars__bar')
    expect(bars).toHaveLength(7)
    expect(beta.querySelectorAll('.fontes-bars__bar--pending')).toHaveLength(3)
    expect(within(beta).getByRole('img')).toHaveAccessibleName(/coletando/)

    const alfa = screen.getByRole('row', { name: /Fonte Alfa/ })
    expect(alfa.querySelectorAll('.fontes-bars__bar--pending')).toHaveLength(0)
  })

  it('shows the last match in local time (UTC 01:43 is 22:43 the day before in America/Sao_Paulo)', async () => {
    stubApi({ sources: [source(1, 'Fonte Alfa', '-1001')], activity: FULL_ACTIVITY })
    renderPage()

    const cell = (await screen.findByRole('row', { name: /Fonte Alfa/ })).querySelector('[data-label="Último match"]')
    expect(cell).toHaveTextContent('19/09')
    expect(cell).toHaveTextContent('22:43')
  })

  it('reads "Nenhuma oferta ainda" for a source without matches', async () => {
    stubApi({ sources: [source(2, 'Fonte Beta', '-1002')], activity: FULL_ACTIVITY })
    renderPage()

    const cell = (await screen.findByRole('row', { name: /Fonte Beta/ })).querySelector('[data-label="Último match"]')
    expect(cell).toHaveTextContent('Nenhuma oferta ainda')
  })

  it('offers Editar and Excluir in the overflow menu, and Excluir asks for confirmation', async () => {
    const calls = stubApi({ sources: [source(1, 'Fonte Alfa', '-1001')], activity: FULL_ACTIVITY })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Mais ações do grupo Fonte Alfa' }))
    expect(screen.getByRole('menuitem', { name: 'Editar' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Excluir' }))

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Excluir' }))
    await vi.waitFor(() => expect(calls).toContain('DELETE /sources/1'))
  })
})

describe('FontesPage rail (S21-11)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const GROUPS = {
    state: 'done',
    error: null,
    dialogs: [
      { chat_id: '-1001', title: 'Fonte Alfa', kind: 'group', monitored: true },
      { chat_id: '-2001', title: 'Ofertas Gamer BR', kind: 'group', monitored: false },
      { chat_id: '-2002', title: 'Hardware Barato', kind: 'channel', monitored: false },
      { chat_id: '-2003', title: 'Cupons & Achados', kind: 'group', monitored: false },
    ],
  }

  it('without Telegram configured, lands on "Por chat_id" and the other tab explains with a link to the wizard', async () => {
    stubApi({ sources: [], activity: FULL_ACTIVITY, setupConfigured: false })
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByLabelText('Chat ID do Telegram')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Da minha conta' }))
    expect(screen.getByText('Telegram ainda não configurado')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'assistente de configuração' })).toHaveAttribute('href', '/configuracao')
  })

  it('lists the account groups, supports multi-select and adds N sources', async () => {
    const calls = stubApi({
      sources: [source(1, 'Fonte Alfa', '-1001')],
      activity: FULL_ACTIVITY,
      setupConfigured: true,
      groups: GROUPS,
    })
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByRole('tab', { name: 'Da minha conta', selected: true })).toBeInTheDocument()
    const gamer = await screen.findByRole('checkbox', { name: /Ofertas Gamer BR/ })
    const hardware = screen.getByRole('checkbox', { name: /Hardware Barato/ })
    expect(screen.getByRole('button', { name: 'Adicionar grupos' })).toBeDisabled()

    await user.click(gamer)
    expect(screen.getByRole('button', { name: 'Adicionar 1 grupo' })).toBeEnabled()
    await user.click(hardware)
    await user.click(screen.getByRole('button', { name: 'Adicionar 2 grupos' }))

    await vi.waitFor(() => expect(calls).toContain('POST /setup/groups/select'))
  })

  it('shows an already registered group checked and disabled', async () => {
    stubApi({
      sources: [source(1, 'Fonte Alfa', '-1001')],
      activity: FULL_ACTIVITY,
      setupConfigured: true,
      groups: GROUPS,
    })
    renderPage()

    const already = await screen.findByRole('checkbox', { name: /Fonte Alfa/ })
    expect(already).toBeChecked()
    expect(already).toBeDisabled()
    expect(screen.getByText('já cadastrada')).toBeInTheDocument()
  })

  it('filters the groups by name and refreshes the list on demand', async () => {
    const calls = stubApi({ sources: [], activity: FULL_ACTIVITY, setupConfigured: true, groups: GROUPS })
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('checkbox', { name: /Ofertas Gamer BR/ })
    await user.type(screen.getByRole('searchbox', { name: 'Buscar grupo' }), 'cupons')
    expect(screen.queryByRole('checkbox', { name: /Ofertas Gamer BR/ })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Cupons/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Atualizar lista' }))
    await vi.waitFor(() => expect(calls).toContain('POST /setup/groups/refresh'))
  })

  it('switches tabs and shows the chat_id form plus the help card', async () => {
    stubApi({ sources: [], activity: FULL_ACTIVITY, setupConfigured: true, groups: GROUPS })
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('tab', { name: 'Por chat_id' }))
    expect(screen.getByRole('tab', { name: 'Por chat_id', selected: true })).toBeInTheDocument()
    expect(screen.getByLabelText('Nome')).toBeInTheDocument()
    expect(screen.getByText('Não aparece na lista?')).toBeInTheDocument()
  })

  it('"+ Novo grupo" focuses the rail', async () => {
    stubApi({ sources: [], activity: FULL_ACTIVITY, setupConfigured: true, groups: GROUPS })
    const user = userEvent.setup()
    renderPage()

    await screen.findByRole('checkbox', { name: /Ofertas Gamer BR/ })
    await user.click(screen.getByRole('button', { name: '+ Novo grupo' }))
    expect(screen.getByRole('searchbox', { name: 'Buscar grupo' })).toHaveFocus()
  })
})

describe('FontesPage empty state (S23-04)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('with the account connected, offers "Adicionar da minha conta" and focuses the rail', async () => {
    stubApi({ sources: [], activity: FULL_ACTIVITY, setupConfigured: true, groups: { state: 'done', error: null, dialogs: [{ chat_id: '-2001', title: 'Ofertas Gamer BR', kind: 'group', monitored: false }] } })
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByText('Nenhum grupo ainda')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Adicionar da minha conta' }))
    expect(screen.getByRole('searchbox', { name: 'Buscar grupo' })).toHaveFocus()
  })
})
