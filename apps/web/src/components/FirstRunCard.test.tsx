import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/auth'
import { FIRST_RUN_KEY, resetFlagMemory } from '../onboarding/storage'
import { buildFirstRunSteps, FirstRunCard, resetFirstRunSession } from './FirstRunCard'
import { FirstTimeTip } from './FirstTimeTip'
import { EmptyState } from './EmptyState'

const api = vi.hoisted(() => ({
  fetchSetupStatus: vi.fn(),
  listRules: vi.fn(),
  listSources: vi.fn(),
  listRecipients: vi.fn(),
}))
vi.mock('../api/setup', () => ({ fetchSetupStatus: api.fetchSetupStatus }))
vi.mock('../api/rules', () => ({ listRules: api.listRules }))
vi.mock('../api/sources', () => ({ listSources: api.listSources }))
vi.mock('../api/recipients', () => ({ listRecipients: api.listRecipients }))

function setup(overrides: { credentials?: boolean; login?: boolean } = {}) {
  return {
    steps: { credentials: overrides.credentials ?? false, login: overrides.login ?? false, bot: false, recipient: false, groups: false, rule: false },
  }
}

function arrange(opts: { setup?: unknown; rules?: number; sources?: number; recipients?: { allowlisted: boolean; active: boolean }[] }) {
  api.fetchSetupStatus.mockResolvedValue(opts.setup ?? setup())
  api.listRules.mockResolvedValue(Array.from({ length: opts.rules ?? 0 }, (_, id) => ({ id })))
  api.listSources.mockResolvedValue(Array.from({ length: opts.sources ?? 0 }, (_, id) => ({ id })))
  api.listRecipients.mockResolvedValue(opts.recipients ?? [])
}

const renderCard = () =>
  render(
    <MemoryRouter>
      <FirstRunCard />
    </MemoryRouter>,
  )

beforeEach(() => {
  window.localStorage.clear()
  resetFlagMemory()
  resetFirstRunSession()
  vi.clearAllMocks()
})
afterEach(cleanup)

describe('buildFirstRunSteps', () => {
  it('marks Telegram done by the wizard state or by having sources', () => {
    const empty = { sources: 0, authorizedRecipients: 0, rules: 0 }
    expect(buildFirstRunSteps(setup() as never, empty)[0]?.done).toBe(false)
    expect(buildFirstRunSteps(setup({ credentials: true, login: true }) as never, empty)[0]?.done).toBe(true)
    expect(buildFirstRunSteps(setup() as never, { ...empty, sources: 2 })[0]?.done).toBe(true)
  })

  it('needs an authorized recipient and at least one rule for the other steps', () => {
    const steps = buildFirstRunSteps(setup() as never, { sources: 0, authorizedRecipients: 1, rules: 3 })
    expect(steps.map((step) => step.done)).toEqual([false, true, true])
    expect(steps[2]?.to).toBe('/regras?nova=1')
  })
})

describe('FirstRunCard', () => {
  it('shows three steps with progress and links for a brand new install', async () => {
    arrange({})
    renderCard()
    expect(await screen.findByRole('heading', { name: 'Comece por aqui' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByRole('link', { name: 'Conectar o Telegram' })).toHaveAttribute('href', '/configuracao')
    expect(screen.getByRole('link', { name: 'Conectar o bot' })).toHaveAttribute('href', '/configuracao')
    expect(screen.getByRole('link', { name: 'Criar a primeira regra' })).toHaveAttribute('href', '/regras?nova=1')
  })

  it('turns done steps into a check with what was done', async () => {
    arrange({ sources: 2, recipients: [{ allowlisted: true, active: true }] })
    renderCard()
    expect(await screen.findByText('Telegram conectado, 2 fontes em monitoramento.')).toBeInTheDocument()
    expect(screen.getByText('1 destinatário autorizado para receber alertas.')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
    expect(screen.queryByRole('link', { name: 'Conectar o bot' })).not.toBeInTheDocument()
  })

  it('ignores a recipient that is not authorized', async () => {
    arrange({ recipients: [{ allowlisted: false, active: true }] })
    renderCard()
    await screen.findByRole('heading', { name: 'Comece por aqui' })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  it('"Pular por agora" hides it and remembers', async () => {
    arrange({})
    const user = userEvent.setup()
    const first = renderCard()
    await user.click(await screen.findByRole('button', { name: 'Pular por agora' }))
    expect(screen.queryByRole('heading', { name: 'Comece por aqui' })).not.toBeInTheDocument()
    expect(window.localStorage.getItem(FIRST_RUN_KEY)).toBe('dismissed')
    first.unmount()
    renderCard()
    await waitFor(() => expect(api.listRules).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('heading', { name: 'Comece por aqui' })).not.toBeInTheDocument()
  })

  it('celebrates "Tudo pronto" once after finishing, then goes away on the next page load', async () => {
    arrange({})
    const first = renderCard()
    await screen.findByRole('heading', { name: 'Comece por aqui' })
    first.unmount()

    arrange({ sources: 1, rules: 1, recipients: [{ allowlisted: true, active: true }] })
    const second = renderCard()
    expect(await screen.findByRole('heading', { name: 'Tudo pronto' })).toBeInTheDocument()
    expect(window.localStorage.getItem(FIRST_RUN_KEY)).toBe('dismissed')
    second.unmount()

    resetFirstRunSession() // a reload
    renderCard()
    await waitFor(() => expect(api.listRules).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('heading', { name: 'Tudo pronto' })).not.toBeInTheDocument()
  })

  it('never shows "Tudo pronto" to someone who was already set up', async () => {
    arrange({ sources: 1, rules: 1, recipients: [{ allowlisted: true, active: true }] })
    renderCard()
    await waitFor(() => expect(api.listRules).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('is absent when the setup API is unavailable (demo)', async () => {
    arrange({})
    api.fetchSetupStatus.mockRejectedValue(new ApiError('demo', 403))
    renderCard()
    await waitFor(() => expect(api.fetchSetupStatus).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('announces nothing on load', async () => {
    arrange({})
    renderCard()
    await screen.findByRole('heading', { name: 'Comece por aqui' })
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('still works with blocked storage', async () => {
    arrange({})
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const user = userEvent.setup()
    renderCard()
    await user.click(await screen.findByRole('button', { name: 'Pular por agora' }))
    expect(screen.queryByRole('heading', { name: 'Comece por aqui' })).not.toBeInTheDocument()
    vi.restoreAllMocks()
  })
})

describe('FirstTimeTip', () => {
  it('shows once and stays closed after "Entendi"', async () => {
    const user = userEvent.setup()
    const first = render(<FirstTimeTip id="t">Para que serve.</FirstTimeTip>)
    expect(screen.getByText('Para que serve.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Entendi' }))
    expect(screen.queryByText('Para que serve.')).not.toBeInTheDocument()
    first.unmount()
    render(<FirstTimeTip id="t">Para que serve.</FirstTimeTip>)
    expect(screen.queryByText('Para que serve.')).not.toBeInTheDocument()
  })

  it('does not crash with blocked storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<FirstTimeTip id="blocked">Dica.</FirstTimeTip>)
    expect(screen.getByText('Dica.')).toBeInTheDocument()
    vi.restoreAllMocks()
  })
})

describe('EmptyState', () => {
  it('renders a button action or a link action', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <EmptyState title="A" text="B" action={{ label: 'Faça', onClick }} />
        <EmptyState title="C" text="D" action={{ label: 'Vá', to: '/regras' }} />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Faça' }))
    expect(onClick).toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Vá' })).toHaveAttribute('href', '/regras')
  })
})
