import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * S23-01: the production nginx (docker/web-nginx.conf) is the only place the security
 * headers are set, so they are checked here as text, like proxyPrefixesSync.test.ts does
 * for the proxy list. The CSP allows exactly one inline script (the pre-paint theme
 * snippet of index.html) by hash: edit that snippet and this test prints the new hash.
 */

const nginx = readFileSync(resolve(__dirname, '../../../docker/web-nginx.conf'), 'utf-8')
const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8')

function header(name: string): string {
  const match = nginx.match(new RegExp(`add_header ${name} "([^"]*)" always;`))
  if (!match) throw new Error(`${name} is not set (with "always") in docker/web-nginx.conf`)
  return match[1]
}

function csp(): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const part of header('Content-Security-Policy').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) directives.set(name, values)
  }
  return directives
}

function inlineScripts(): string[] {
  return [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

describe('security headers of the production nginx (S23-01)', () => {
  it('hides the version, caps the body and never overrides headers per location', () => {
    expect(nginx).toMatch(/server_tokens off;/)
    expect(nginx).toMatch(/client_max_body_size \d+k;/)
    const locations = nginx.slice(nginx.indexOf('location ~'))
    expect(locations).not.toMatch(/add_header/)
  })

  it('sends the basic hardening headers', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff')
    expect(header('X-Frame-Options')).toBe('DENY')
    expect(header('Referrer-Policy')).toBe('no-referrer')
    const permissions = header('Permissions-Policy')
    for (const feature of ['camera', 'microphone', 'geolocation']) {
      expect(permissions).toContain(`${feature}=()`)
    }
  })

  it('has a CSP that locks everything down to this origin and the font host', () => {
    const policy = csp()
    expect(policy.get('default-src')).toEqual(["'self'"])
    expect(policy.get('object-src')).toEqual(["'none'"])
    expect(policy.get('base-uri')).toEqual(["'self'"])
    expect(policy.get('form-action')).toEqual(["'self'"])
    expect(policy.get('frame-ancestors')).toEqual(["'none'"])
    expect(policy.get('connect-src')).toEqual(["'self'"])
    expect(policy.get('font-src')).toEqual(["'self'", 'https://fonts.gstatic.com'])
    expect(policy.get('style-src')).toContain('https://fonts.googleapis.com')
  })

  it('does not allow arbitrary scripts: no unsafe-inline, no unsafe-eval, no wildcard', () => {
    const scripts = csp().get('script-src') ?? []
    expect(scripts).toContain("'self'")
    expect(scripts).not.toContain("'unsafe-inline'")
    expect(scripts).not.toContain("'unsafe-eval'")
    expect(scripts.join(' ')).not.toMatch(/\*|https?:/)
  })

  it('allows exactly the inline scripts that index.html has, by hash', () => {
    const allowed = (csp().get('script-src') ?? []).filter((v) => v.startsWith("'sha256-"))
    const actual = inlineScripts().map(
      (body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`,
    )
    expect(actual.length).toBeGreaterThan(0)
    expect([...allowed].sort()).toEqual([...actual].sort())
  })

  it('every external host index.html loads is listed in the CSP', () => {
    const hosts = [...indexHtml.matchAll(/(?:href|src)="(https:\/\/[^"/]+)/g)].map((m) => m[1])
    const policy = header('Content-Security-Policy')
    for (const host of new Set(hosts)) {
      if (host === 'https://fonts.googleapis.com' || host === 'https://fonts.gstatic.com') {
        expect(policy).toContain(host)
      }
    }
  })
})
