/**
 * S19-02: client-side format checks of the setup wizard. They only save a round
 * trip: the server validates the same shapes again (apps/api/app/routers/setup.py)
 * and is the authority. None of these helpers logs or stores what it is given.
 */

const API_HASH = /^[0-9a-fA-F]{32}$/
const BOT_TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/
const E164 = /^\+[1-9]\d{6,14}$/
const CODE = /^\d{4,8}$/

export const MAX_API_ID = 2 ** 31 - 1

export function validateApiId(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return 'Informe o api_id.'
  if (!/^\d+$/.test(text)) return 'O api_id é só números (ex.: 1234567).'
  const value = Number(text)
  if (value <= 0 || value > MAX_API_ID) return 'Esse api_id não parece válido. Copie de my.telegram.org/apps.'
  return null
}

export function validateApiHash(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return 'Informe o api_hash.'
  if (!API_HASH.test(text)) {
    return 'O api_hash tem 32 caracteres (números e letras de a a f). Copie inteiro de my.telegram.org/apps.'
  }
  return null
}

export function validateBotToken(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return 'Cole o token do bot.'
  if (!BOT_TOKEN.test(text)) {
    return 'O token tem o formato 123456789:ABC… Copie-o inteiro da conversa com o @BotFather.'
  }
  return null
}

/** Strips spaces, dashes, dots and parentheses people type into a phone number. */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s().-]/g, '')
}

export function validatePhone(raw: string): string | null {
  const text = normalizePhone(raw)
  if (text === '') return 'Informe o telefone da conta do Telegram.'
  if (!text.startsWith('+')) return 'Comece com + e o código do país, por exemplo +5511999998888.'
  if (!E164.test(text)) return 'O número parece incompleto. Use o formato +5511999998888.'
  return null
}

export function validateLoginCode(raw: string): string | null {
  const text = raw.replace(/\s/g, '')
  if (text === '') return 'Digite o código que o Telegram enviou.'
  if (!CODE.test(text)) return 'O código tem de 4 a 8 números.'
  return null
}

export const secondsLabel = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  const rest = safe % 60
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest}s`
}
