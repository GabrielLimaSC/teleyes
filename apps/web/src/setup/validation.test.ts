import { describe, expect, it } from 'vitest'
import {
  normalizePhone,
  secondsLabel,
  validateApiHash,
  validateApiId,
  validateBotToken,
  validateLoginCode,
  validatePhone,
} from './validation'

describe('setup wizard validation (S19-02)', () => {
  it('accepts a real-looking api_id and refuses everything else', () => {
    expect(validateApiId('1234567')).toBeNull()
    for (const bad of ['', 'abc', '12.5', '-3', '0', String(2 ** 31)]) {
      expect(validateApiId(bad)).not.toBeNull()
    }
  })

  it('needs exactly 32 hex characters for the api_hash', () => {
    expect(validateApiHash('0123456789abcdef0123456789ABCDEF')).toBeNull()
    for (const bad of ['', 'short', 'z'.repeat(32), '0'.repeat(33)]) {
      expect(validateApiHash(bad)).not.toBeNull()
    }
  })

  it('checks the shape of a bot token without caring about spaces around it', () => {
    expect(validateBotToken(' 123456789:AAFakeTokenFakeTokenFakeTokenFake_x1 ')).toBeNull()
    for (const bad of ['', 'abc', '123:short', 'http://x/123456789:AAFakeTokenFakeTokenFakeTokenFake']) {
      expect(validateBotToken(bad)).not.toBeNull()
    }
  })

  it('normalises the phone the way people type it and demands the + and country code', () => {
    expect(normalizePhone('+55 (11) 98765-4321')).toBe('+5511987654321')
    expect(validatePhone('+55 (11) 98765-4321')).toBeNull()
    expect(validatePhone('11987654321')).toMatch(/Comece com \+/)
    expect(validatePhone('+55')).toMatch(/incompleto/)
    expect(validatePhone('')).not.toBeNull()
  })

  it('takes 4 to 8 digits as the login code, ignoring spaces', () => {
    expect(validateLoginCode('12 345')).toBeNull()
    for (const bad of ['', '12', 'abcde', '123456789']) expect(validateLoginCode(bad)).not.toBeNull()
  })

  it('formats countdowns', () => {
    expect(secondsLabel(299)).toBe('4:59')
    expect(secondsLabel(42)).toBe('42s')
    expect(secondsLabel(-3)).toBe('0s')
  })
})
