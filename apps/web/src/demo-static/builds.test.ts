import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * S19-05: builds the app twice and inspects the output.
 *  - the normal bundle must not contain the mock, the fixtures or the demo strip
 *    (the static demo is gated by `import.meta.env.VITE_DEMO_STATIC` and tree-shaken);
 *  - the static bundle must be usable under /teleyes/ and carry nothing that looks
 *    like a secret or a real Telegram id.
 */

const WEB_ROOT = resolve(__dirname, '../..')
const VITE = resolve(WEB_ROOT, 'node_modules/.bin/vite')

let scratch = ''
let normalDir = ''
let staticDir = ''

function build(outDir: string, env: Record<string, string>, mode: string): void {
  execFileSync(VITE, ['build', '--mode', mode, '--outDir', outDir, '--emptyOutDir'], {
    cwd: WEB_ROOT,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  })
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })
}

function textFiles(dir: string): { path: string; text: string }[] {
  return listFiles(dir)
    .filter((path) => /\.(html|js|css|json|svg)$/.test(path))
    .map((path) => ({ path, text: readFileSync(path, 'utf-8') }))
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'teleyes-builds-'))
  normalDir = join(scratch, 'normal')
  staticDir = join(scratch, 'static')
  build(normalDir, {}, 'production')
  build(staticDir, { VITE_DEMO_STATIC: '1', VITE_BASE: '/teleyes/' }, 'demo-static')
}, 180_000)

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

describe('normal build', () => {
  it('contains no trace of the static demo', () => {
    const forbidden = [
      'demo-static',
      'bootDemoStatic',
      'DemoStaticStrip',
      'demo-csrf-token',
      'nada é salvo',
      'example.com/oferta',
      'reference_now',
    ]
    for (const { path, text } of textFiles(normalDir)) {
      for (const needle of forbidden) expect(text.includes(needle), `${needle} in ${path}`).toBe(false)
    }
    expect(listFiles(normalDir).some((path) => /fixtures/.test(path))).toBe(false)
  })

  it('keeps the root base path and writes no 404.html', () => {
    const html = readFileSync(join(normalDir, 'index.html'), 'utf-8')
    expect(html).toContain('src="/assets/')
    expect(listFiles(normalDir).some((path) => path.endsWith('404.html'))).toBe(false)
  })
})

describe('demo-static build', () => {
  it('serves assets, favicon and the SPA fallback under /teleyes/', () => {
    const html = readFileSync(join(staticDir, 'index.html'), 'utf-8')
    expect(html).toContain('src="/teleyes/assets/')
    expect(html).toContain('href="/teleyes/favicon.svg"')
    expect(readFileSync(join(staticDir, '404.html'), 'utf-8')).toBe(html)
    expect(statSync(join(staticDir, 'mascot.png')).size).toBeGreaterThan(0)
  })

  it('has no secret-looking string and no real Telegram id', () => {
    const patterns: [string, RegExp][] = [
      ['bot token', /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/],
      ['channel/supergroup id', /-100\d{6,}/],
      ['api hash', /\b[0-9a-f]{32}\b/],
      ['session file', /\w\.session\b/],
      ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ['env secret names', /\b(BOT_TOKEN|TG_API_HASH|TG_API_ID)\s*[=:]\s*["']?\w/],
    ]
    for (const { path, text } of textFiles(staticDir)) {
      for (const [label, pattern] of patterns) {
        expect(pattern.test(text), `${label} in ${path}`).toBe(false)
      }
    }
  })

  it('ships fixtures with only demo ids and example.com links', () => {
    const chunk = textFiles(staticDir).find(({ path }) => /assets\/fixtures-.*\.js$/.test(path))
    expect(chunk, 'fixtures chunk').toBeDefined()
    const text = chunk!.text
    const chatIds = [...text.matchAll(/telegram_chat_id\\?":\\?"([^"\\]*)/g)].map((match) => match[1])
    expect(chatIds.length).toBeGreaterThan(0)
    for (const id of chatIds) expect(id.startsWith('demo:')).toBe(true)
    const hosts = new Set([...text.matchAll(/https?:\/\/([^/"\s\\]+)/g)].map((match) => match[1]))
    expect([...hosts]).toEqual(['example.com'])
  })
})
