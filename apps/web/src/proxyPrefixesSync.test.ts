import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * S14-08 review: `docker/web-nginx.conf`'s proxy `location` regex must list
 * the same backend prefixes as `vite.config.ts`'s dev proxy — the nginx
 * config is what actually serves `/products` (and, since S14-03, `/snoozes`)
 * in production; the vite proxy only covers `npm run dev`. A prefix added to
 * one and not the other passed dev/tests fine and then 404'd (well,
 * fell through to `index.html`) for real users. This test reads both files
 * as text and fails loudly the next time that happens, instead of relying on
 * someone remembering to keep the two lists in sync by hand.
 */

function readViteApiPrefixes(): string[] {
  const source = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf-8')
  const match = source.match(/const API_PREFIXES = \[([\s\S]*?)\]/)
  if (!match) throw new Error('API_PREFIXES array not found in vite.config.ts')
  const body = match[1]
  return [...body.matchAll(/'\/([^']+)'/g)].map((m) => m[1])
}

function readNginxApiPrefixes(): string[] {
  const source = readFileSync(resolve(__dirname, '../../../docker/web-nginx.conf'), 'utf-8')
  const match = source.match(/location ~ \^\/\(([^)]+)\)/)
  if (!match) throw new Error('proxy location regex not found in docker/web-nginx.conf')
  return match[1].split('|').map((prefix) => prefix.replace(/\\\./g, '.'))
}

describe('proxy prefixes stay in sync (S14-08 review)', () => {
  it('lists the same backend prefixes in vite.config.ts and docker/web-nginx.conf', () => {
    const vitePrefixes = readViteApiPrefixes()
    const nginxPrefixes = readNginxApiPrefixes()

    expect(vitePrefixes.length).toBeGreaterThan(0)
    expect(nginxPrefixes.length).toBeGreaterThan(0)
    expect([...vitePrefixes].sort()).toEqual([...nginxPrefixes].sort())
  })
})
