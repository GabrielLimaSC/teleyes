/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * S13-01 guard: an API timestamp becomes a `Date` in exactly one place,
 * `utils/dates.ts` (`parseApiDate`). Anything else that parses a string
 * (`new Date(x)`, `Date.parse`) or bolts a `Z` on it re-opens the bug where a
 * zone-less API string is read as LOCAL time. `new Date()` with no argument
 * (the clock) and `new Date(y, m, d, …)`-style arithmetic on an existing Date
 * live in `dates.ts` too, so the only allowed spelling elsewhere is `new Date()`.
 * Comments and test files are not scanned.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const THE_ONE_PLACE = 'utils/dates.ts'

const FORBIDDEN: Array<[string, RegExp]> = [
  ['new Date(<argument>)', /new\s+Date\(\s*[^\s)]/],
  ['Date.parse(', /Date\.parse\(/],
  ['toISOString(', /\.toISOString\(/],
  ["a hand-made 'Z' suffix", /\+\s*['"`]Z['"`]|`\$\{[^}]*\}Z`/],
]

function stripComments(source: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlock.replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

export function findForbidden(source: string): string[] {
  const code = stripComments(source)
  return FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([label]) => label)
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function sourceFiles(): string[] {
  return walk(SRC_ROOT)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.test\.(ts|tsx)$/.test(file))
    .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join('/'))
}

describe('findForbidden (the detector itself)', () => {
  it('flags every way of parsing an API timestamp outside the one place', () => {
    expect(findForbidden('const d = new Date(match.matched_at)')).toEqual(['new Date(<argument>)'])
    expect(findForbidden('new Date(iso).toLocaleString()')).toEqual(['new Date(<argument>)'])
    expect(findForbidden('const t = Date.parse(x)')).toEqual(['Date.parse('])
    expect(findForbidden('stamp.toISOString().slice(0, 10)')).toEqual(['toISOString('])
    expect(findForbidden("new Date(match.matched_at + 'Z')")).toEqual([
      'new Date(<argument>)',
      "a hand-made 'Z' suffix",
    ])
    expect(findForbidden('const s = `${iso}Z`')).toEqual(["a hand-made 'Z' suffix"])
  })

  it('accepts the clock and comments', () => {
    expect(findForbidden('const now = new Date()')).toEqual([])
    expect(findForbidden('// new Date(iso) would read it as local')).toEqual([])
    expect(findForbidden('/* Date.parse(x) */ const a = 1')).toEqual([])
  })
})

describe('no API timestamp is parsed outside utils/dates.ts (S13-01)', () => {
  const files = sourceFiles()

  it('scans the real source tree and the one allowed file', () => {
    expect(files).toContain(THE_ONE_PLACE)
    expect(files).toContain('pages/HistoricoPage.tsx')
    expect(files).toContain('components/MatchCard.tsx')
    expect(files).not.toContain('pages/HistoricoPage.test.tsx')
  })

  it('has no forbidden date parsing in any other file', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file === THE_ONE_PLACE) continue
      const found = findForbidden(readFileSync(path.join(SRC_ROOT, file), 'utf8'))
      if (found.length > 0) offenders.push(`${file}: ${found.join(', ')}`)
    }
    expect(offenders, `route API timestamps through parseApiDate (utils/dates.ts):\n${offenders.join('\n')}`).toEqual(
      [],
    )
  })
})
