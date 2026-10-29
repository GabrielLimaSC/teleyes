import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetupStatus } from '../api/setup'
import { ConfiguracaoPage } from './ConfiguracaoPage'

vi.mock('../auth/AuthContext', () => ({
  CSRF_MISSING_MESSAGE: 'csrf ausente',
  useAuth: () => ({ csrfToken: 'test-csrf' }),
}))

const API_HASH = '0123456789abcdef0123456789abcdef'
const TOKEN = '123456789:AAFakeTokenFakeTokenFakeTokenFake_x1'

function statusOf(over: Partial<SetupStatus> = {}, steps: Partial<SetupStatus['steps']> = {}): SetupStatus {
  const merged = {
    credentials: false,
    login: false,
    bot: false,
    recipient: false,
    groups: false,
    rule: false,
    ...steps,
  }
  const order = ['credentials', 'login', 'bot', 'recipient', 'groups', 'rule'] as const
  const next = order.find((key) => !merged[key]) ?? 'done'
  return {
    credentials: { configured: merged.credentials, source: merged.credentials ? 'wizard' : null },
    login: { state: merged.login ? 'authorized' : 'none' },
    bot: {
      configured: merged.bot,
      source: merged.bot ? 'wizard' : null,
      username: merged.bot ? 'teleyes_bot' : null,
      pairing_active: false,
      pairing_expires_in_seconds: null,
    },
    recipients: merged.recipient ? 1 : 0,
    sources: merged.groups ? 2 : 0,
    rules: merged.rule ? 1 : 0,
    listener_online: false,
    steps: merged,
    next_step: next,
    configured: merged.credentials && merged.login && merged.bot,
    complete: false,
    events: [],
    ...over,
  }
}

type Handler = (body: unknown) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const apiError = (status: number, code: string, message: string, retry?: number) =>
  json({ detail: { code, message, ...(retry === undefined ? {} : { retry_after_seconds: retry }) } }, status)

/** A fake API: `routes["POST /path"]` handlers; the body arrives parsed. Records every call. */
function serve(routes: Record<string, Handler>) {
  const calls: { key: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = String(input).split('?')[0]
      const key = `${method} ${path}`
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ key, body })
      const handler = routes[key]
      if (!handler) return Promise.resolve(json({ detail: `unexpected ${key}` }, 404))
      return Promise.resolve(handler(body))
    }),
  )
  return calls
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ConfiguracaoPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  // Real timers, but a fast poll is not needed: the page re-reads on every action.
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ConfiguracaoPage (S19-02)', () => {
  it('resumes at the step the server says is next and shows the others as done or pending', async () => {
    serve({ 'GET /setup/status': () => json(statusOf({}, { credentials: true, login: true })) })

    renderPage()

    const bot = await screen.findByRole('button', { name: /Bot de alertas/ })
    expect(bot).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /Credenciais do aplicativo Telegram/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.getByText('Token do bot')).toBeInTheDocument()
    expect(screen.getAllByText('Concluído')).toHaveLength(2)
  })

  it('lets a done step be reopened and collapsed', async () => {
    serve({ 'GET /setup/status': () => json(statusOf({}, { credentials: true })) })
    renderPage()
    const first = await screen.findByRole('button', { name: /Credenciais do aplicativo Telegram/ })

    await userEvent.click(first)
    expect(first).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(first)
    expect(first).toHaveAttribute('aria-expanded', 'false')
  })

  it('validates the credentials before calling the server, then saves and clears the fields', async () => {
    const after = statusOf({}, { credentials: true })
    const calls = serve({
      'GET /setup/status': () => json(statusOf()),
      'PUT /setup/credentials': () => json(after),
    })
    renderPage()
    const user = userEvent.setup()
    await screen.findByText('api_id', { selector: 'label' })

    await user.click(screen.getByRole('button', { name: 'Salvar credenciais' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Informe o api_id')
    await user.type(screen.getByLabelText('api_id'), '1234567')
    await user.type(screen.getByLabelText('api_hash'), 'curto')
    await user.click(screen.getByRole('button', { name: 'Salvar credenciais' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('32 caracteres')
    expect(calls.some((call) => call.key === 'PUT /setup/credentials')).toBe(false)

    await user.clear(screen.getByLabelText('api_hash'))
    await user.type(screen.getByLabelText('api_hash'), API_HASH)
    await user.click(screen.getByRole('button', { name: 'Salvar credenciais' }))

    await waitFor(() =>
      expect(calls.find((call) => call.key === 'PUT /setup/credentials')?.body).toEqual({
        api_id: 1234567,
        api_hash: API_HASH,
      }),
    )
    // Moved on to the login step and no secret stayed in the document.
    expect(await screen.findByLabelText(/Telefone/)).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain(API_HASH)
  })

  it('shows credentials that come from .env as read only', async () => {
    const status = statusOf({}, { credentials: true })
    status.credentials = { configured: true, source: 'env' }
    serve({ 'GET /setup/status': () => json(status) })
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: /Credenciais do aplicativo Telegram/ }))

    expect(screen.getByText(/já estão definidos no arquivo/)).toBeInTheDocument()
    expect(screen.queryByLabelText('api_hash')).not.toBeInTheDocument()
  })

  describe('login', () => {
    const base = statusOf({}, { credentials: true })

    it('asks for the phone with the account warning, then the code, and shows the server error for a wrong code', async () => {
      let current = base
      const calls = serve({
        'GET /setup/status': () => json(current),
        'POST /setup/telegram/login/start': () => {
          current = {
            ...base,
            login: { state: 'awaiting_code', phone_hint: '+55•••••••4321', expires_in_seconds: 290 },
          }
          return json(current)
        },
        'POST /setup/telegram/login/code': (body) =>
          (body as { code: string }).code === '13579'
            ? json(statusOf({}, { credentials: true, login: true }))
            : apiError(422, 'code_invalid', 'Código incorreto. Confira a mensagem do Telegram e tente de novo.'),
      })
      renderPage()
      const user = userEvent.setup()

      expect(await screen.findByText(/acesso total à conta do Telegram/)).toBeInTheDocument()
      await user.type(screen.getByLabelText(/Telefone/), '11999998888')
      await user.click(screen.getByRole('button', { name: /Enviar código/ }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Comece com +')

      await user.clear(screen.getByLabelText(/Telefone/))
      await user.type(screen.getByLabelText(/Telefone/), '+55 (11) 99999-8888')
      await user.click(screen.getByRole('button', { name: /Enviar código/ }))

      expect(await screen.findByText('+55•••••••4321')).toBeInTheDocument()
      expect(calls.find((call) => call.key === 'POST /setup/telegram/login/start')?.body).toEqual({
        phone: '+5511999998888',
      })
      expect(screen.getByText(/o código vale por mais/i)).toBeInTheDocument()

      await user.type(screen.getByLabelText('Código'), '00000')
      await user.click(screen.getByRole('button', { name: /Confirmar código/ }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Código incorreto')

      await user.clear(screen.getByLabelText('Código'))
      await user.type(screen.getByLabelText('Código'), '13579')
      await user.click(screen.getByRole('button', { name: /Confirmar código/ }))
      // Next step: the bot token.
      expect(await screen.findByLabelText('Token do bot')).toBeInTheDocument()
    })

    it('resumes at the code step after a reload (state comes from the server)', async () => {
      serve({
        'GET /setup/status': () =>
          json({
            ...base,
            login: { state: 'awaiting_code', phone_hint: '+55•••••••4321', expires_in_seconds: 200 },
          }),
      })

      renderPage()

      expect(await screen.findByLabelText('Código')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Cancelar e recomeçar' })).toBeInTheDocument()
    })

    it('asks for the 2FA password when the account has one', async () => {
      const calls = serve({
        'GET /setup/status': () =>
          json({ ...base, login: { state: 'awaiting_password', phone_hint: '+55•••••••4321', expires_in_seconds: 100 } }),
        'POST /setup/telegram/login/password': () => apiError(422, 'password_invalid', 'Senha da verificação em duas etapas incorreta.'),
      })
      renderPage()
      const user = userEvent.setup()

      await user.type(await screen.findByLabelText(/Senha da verificação/), 'segredo-2fa')
      await user.click(screen.getByRole('button', { name: /Entrar/ }))

      expect(await screen.findByRole('alert')).toHaveTextContent('duas etapas incorreta')
      expect(calls.find((call) => call.key === 'POST /setup/telegram/login/password')?.body).toEqual({
        password: 'segredo-2fa',
      })
      expect(document.body.innerHTML).not.toContain('segredo-2fa')
    })

    it('blocks the button and counts down when Telegram or the server asks to wait', async () => {
      serve({
        'GET /setup/status': () => json(base),
        'POST /setup/telegram/login/start': () =>
          apiError(429, 'flood_wait', 'O Telegram pediu para aguardar 13 minutos antes de tentar de novo.', 754),
      })
      renderPage()
      const user = userEvent.setup()

      await user.type(await screen.findByLabelText(/Telefone/), '+5511999998888')
      await user.click(screen.getByRole('button', { name: /Enviar código/ }))

      expect(await screen.findByRole('alert')).toHaveTextContent('13 minutos')
      const button = screen.getByRole('button', { name: /aguarde 12:3\d/ })
      expect(button).toBeDisabled()
    })

    it('disconnects only after the confirmation', async () => {
      const connected = statusOf({}, { credentials: true, login: true })
      const calls = serve({
        'GET /setup/status': () => json(connected),
        'POST /setup/telegram/disconnect': () => json(statusOf()),
      })
      renderPage()
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /Conta do Telegram/ }))

      await user.click(screen.getByRole('button', { name: 'Desconectar Telegram' }))
      const dialog = await screen.findByRole('alertdialog')
      await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
      expect(calls.some((call) => call.key === 'POST /setup/telegram/disconnect')).toBe(false)

      await user.click(screen.getByRole('button', { name: 'Desconectar Telegram' }))
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Desconectar' }))

      await waitFor(() =>
        expect(calls.find((call) => call.key === 'POST /setup/telegram/disconnect')?.body).toEqual({
          confirm: true,
        }),
      )
      // Back to the first step.
      expect(await screen.findByLabelText('api_hash')).toBeInTheDocument()
    })
  })

  describe('bot', () => {
    it('validates the token locally, then with the server, showing only the @username', async () => {
      const done = statusOf({}, { credentials: true, login: true, bot: true })
      const calls = serve({
        'GET /setup/status': () => json(statusOf({}, { credentials: true, login: true })),
        'PUT /setup/bot': () => json(done),
        'GET /recipients': () => json([]),
      })
      renderPage()
      const user = userEvent.setup()

      await user.type(await screen.findByLabelText('Token do bot'), 'invalido')
      await user.click(screen.getByRole('button', { name: 'Validar token' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('123456789:ABC')
      expect(calls.some((call) => call.key === 'PUT /setup/bot')).toBe(false)

      await user.clear(screen.getByLabelText('Token do bot'))
      await user.type(screen.getByLabelText('Token do bot'), TOKEN)
      await user.click(screen.getByRole('button', { name: 'Validar token' }))

      expect(await screen.findByRole('link', { name: '@teleyes_bot' })).toBeInTheDocument()
      expect(document.body.innerHTML).not.toContain(TOKEN)
    })

    it('shows the server error for a token Telegram does not know', async () => {
      serve({
        'GET /setup/status': () => json(statusOf({}, { credentials: true, login: true })),
        'PUT /setup/bot': () => apiError(422, 'token_invalid', 'O Telegram não reconheceu este token. Copie-o de novo do @BotFather.'),
      })
      renderPage()
      const user = userEvent.setup()

      await user.type(await screen.findByLabelText('Token do bot'), TOKEN)
      await user.click(screen.getByRole('button', { name: 'Validar token' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('não reconheceu')
    })

    it('pairs a recipient through the deep link, then edits the name and sends a test', async () => {
      let pairingActive = false
      let paired = false
      let startSent = false
      const botDone = () => {
        const status = statusOf({}, { credentials: true, login: true, bot: true, recipient: paired })
        status.bot.pairing_active = pairingActive
        status.bot.pairing_expires_in_seconds = pairingActive ? 590 : null
        return status
      }
      const calls = serve({
        'GET /setup/status': () => json(botDone()),
        'GET /recipients': () =>
          json(paired ? [{ id: 7, name: 'Gabriel', telegram_chat_id: '555', allowlisted: true, active: true, created_at: '2026-01-01T00:00:00Z' }] : []),
        'POST /setup/bot/pairing': () => {
          pairingActive = true
          return json({ code: 'abc123', deep_link: 'https://t.me/teleyes_bot?start=abc123', bot_username: 'teleyes_bot', expires_in_seconds: 600 })
        },
        'POST /setup/bot/pairing/poll': () => {
          if (!startSent) return json({ state: 'waiting', ignored_starts: 1 })
          pairingActive = false
          paired = true
          return json({ state: 'paired', recipient: { id: 7, name: 'Gabriel' }, ignored_starts: 0 })
        },
        'PATCH /recipients/7': () => json({ id: 7, name: 'Gabriel Lima' }),
        'POST /notifications/test': () => json({ delivered: true, status: 'sent', recipient_id: 7, chat_id: '555' }),
      })
      renderPage()
      const user = userEvent.setup()

      await user.click(await screen.findByRole('button', { name: 'Gerar link de pareamento' }))
      const link = await screen.findByRole('link', { name: /Abrir @teleyes_bot no Telegram/ })
      expect(link).toHaveAttribute('href', 'https://t.me/teleyes_bot?start=abc123')
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
      expect(await screen.findByText(/Recebi 1 \/start sem o código/)).toBeInTheDocument()
      startSent = true // the person taps "Iniciar" in Telegram

      expect(await screen.findByText(/Gabriel cadastrado/, {}, { timeout: 5000 })).toBeInTheDocument()
      const name = await screen.findByLabelText('Nome do destinatário')
      await user.clear(name)
      await user.type(name, 'Gabriel Lima')
      await user.tab()
      await waitFor(() => expect(calls.find((call) => call.key === 'PATCH /recipients/7')?.body).toEqual({ name: 'Gabriel Lima' }))

      await user.click(screen.getByRole('button', { name: 'Enviar mensagem de teste' }))
      expect(await screen.findByText(/Mensagem de teste entregue/)).toBeInTheDocument()
    }, 15000)
  })

  describe('groups', () => {
    const ready = statusOf({}, { credentials: true, login: true, bot: true, recipient: true })

    it('lists the groups the listener found, selects some and saves them', async () => {
      let state: 'idle' | 'done' = 'idle'
      const calls = serve({
        'GET /setup/status': () => json(ready),
        'GET /setup/groups': () =>
          json({
            state,
            error: null,
            dialogs:
              state === 'done'
                ? [
                    { chat_id: '-1001', title: 'Promoções PC', kind: 'group', monitored: false },
                    { chat_id: '-1002', title: 'Ofertas Canal', kind: 'channel', monitored: true },
                  ]
                : [],
          }),
        'POST /setup/groups/refresh': () => {
          state = 'done'
          return json({
            state,
            error: null,
            dialogs: [
              { chat_id: '-1001', title: 'Promoções PC', kind: 'group', monitored: false },
              { chat_id: '-1002', title: 'Ofertas Canal', kind: 'channel', monitored: true },
            ],
          })
        },
        'POST /setup/groups/select': () => json({ created: 1, already_monitored: 0 }),
      })
      renderPage()
      const user = userEvent.setup()

      expect(await screen.findByText(/nunca entra em grupos, responde, reage nem encaminha/)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Buscar meus grupos' }))

      const monitored = await screen.findByRole('checkbox', { name: /Ofertas Canal/ })
      expect(monitored).toBeChecked()
      expect(monitored).toBeDisabled()
      await user.click(screen.getByRole('checkbox', { name: /Promoções PC/ }))
      await user.click(screen.getByRole('button', { name: 'Monitorar 1 selecionado(s)' }))

      await waitFor(() =>
        expect(calls.find((call) => call.key === 'POST /setup/groups/select')?.body).toEqual({ chat_ids: ['-1001'] }),
      )
      expect(await screen.findByText(/1 grupo\(s\) adicionado\(s\)/)).toBeInTheDocument()
    })

    it('says the monitor is still starting, and reports a failed scan', async () => {
      serve({
        'GET /setup/status': () => json(ready),
        'GET /setup/groups': () => json({ state: 'waiting_listener', error: null, dialogs: [] }),
      })
      renderPage()
      expect(await screen.findByText(/O monitor ainda está iniciando/)).toBeInTheDocument()
    })

    it('explains what is missing before the groups can be listed', async () => {
      serve({ 'GET /setup/status': () => json(statusOf({}, { credentials: true })) })
      renderPage()
      await userEvent.click(await screen.findByRole('button', { name: /Grupos para monitorar/ }))
      expect(screen.getByText(/Termine as credenciais, o login da conta e o bot/)).toBeInTheDocument()
    })
  })

  describe('first rule', () => {
    const ready = statusOf({}, { credentials: true, login: true, bot: true, recipient: true, groups: true })

    it('creates the rule from a template and asks the listener to reload', async () => {
      const calls = serve({
        'GET /setup/status': () => json(ready),
        'POST /rules': (body) => json({ id: 1, name: (body as { name: string }).name }),
        'POST /listener/reload': () => json({ state: 'pending' }, 202),
      })
      renderPage()
      const user = userEvent.setup()

      await user.click(await screen.findByRole('button', { name: 'Placa de vídeo RTX 5070' }))
      expect(screen.getByLabelText('Nome da regra')).toHaveValue('Placa de vídeo RTX 5070')
      await user.type(screen.getByLabelText(/Preço máximo/), '4.500')
      await user.click(screen.getByRole('button', { name: 'Criar regra e aplicar' }))

      await waitFor(() =>
        expect(calls.find((call) => call.key === 'POST /rules')?.body).toEqual({
          name: 'Placa de vídeo RTX 5070',
          include_terms: 'rtx 5070, rtx5070',
          max_price_cents: 450000,
        }),
      )
      expect(calls.some((call) => call.key === 'POST /listener/reload')).toBe(true)
      expect(await screen.findByText(/criada e enviada ao monitor/)).toBeInTheDocument()
    })

    it('refuses a rule without a name, terms or with a bad price', async () => {
      const calls = serve({ 'GET /setup/status': () => json(ready) })
      renderPage()
      const user = userEvent.setup()

      await user.click(await screen.findByRole('button', { name: 'Regra livre' }))
      await user.click(screen.getByRole('button', { name: 'Criar regra e aplicar' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Dê um nome')
      await user.type(screen.getByLabelText('Nome da regra'), 'Teclado')
      await user.click(screen.getByRole('button', { name: 'Criar regra e aplicar' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('pelo menos um termo')
      expect(calls.some((call) => call.key === 'POST /rules')).toBe(false)
    })
  })

  describe('final checklist', () => {
    it('is only "tudo pronto" when the listener is really up', async () => {
      const everything = statusOf({}, { credentials: true, login: true, bot: true, recipient: true, groups: true, rule: true })
      serve({ 'GET /setup/status': () => json({ ...everything, listener_online: false }) })
      const { unmount } = renderPage()
      const list = await screen.findByRole('list', { name: 'Verificação ao vivo' })
      expect(within(list).getByText(/Monitor conectado/)).toHaveTextContent('pendente')
      expect(screen.queryByText(/Tudo pronto\./)).not.toBeInTheDocument()
      unmount()

      serve({ 'GET /setup/status': () => json({ ...everything, listener_online: true, complete: true }) })
      renderPage()
      expect(await screen.findByText(/Tudo pronto\./)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Ir para o Feed' })).toHaveAttribute('href', '/feed')
    })
  })

  it('explains the demo lock instead of the wizard', async () => {
    serve({ 'GET /setup/status': () => apiError(403, 'demo_mode', 'desativado') })
    renderPage()
    expect(await screen.findByText(/desativado na demonstração/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Credenciais/ })).not.toBeInTheDocument()
  })
})
