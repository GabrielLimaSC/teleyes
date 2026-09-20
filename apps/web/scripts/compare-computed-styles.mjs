#!/usr/bin/env node
// S12-01: exact before/after check for the visual baseline (see
// e2e/visual.spec.ts). Compares two directories of computed-style dumps
// (VISUAL_STYLES_OUT) shot by shot and prints every element/property whose
// computed value differs. Exit code 1 on any difference.
//
//   node scripts/compare-computed-styles.mjs <before-dir> <after-dir>
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const [beforeDir, afterDir] = process.argv.slice(2)
if (!beforeDir || !afterDir) {
  console.error('usage: compare-computed-styles.mjs <before-dir> <after-dir>')
  process.exit(2)
}

const load = (dir, file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
const beforeFiles = readdirSync(beforeDir).filter((file) => file.endsWith('.json')).sort()
const afterFiles = new Set(readdirSync(afterDir).filter((file) => file.endsWith('.json')))

let shots = 0
let elements = 0
let differences = 0

for (const file of beforeFiles) {
  if (!afterFiles.has(file)) {
    console.log(`MISSING in after: ${file}`)
    differences += 1
    continue
  }
  shots += 1
  const before = load(beforeDir, file)
  const after = load(afterDir, file)
  const keys = new Set([...Object.keys(before.styles), ...Object.keys(after.styles)])
  for (const key of keys) {
    elements += 1
    const a = before.styles[key]
    const b = after.styles[key]
    if (a === undefined || b === undefined) {
      console.log(`${file}: element ${key} exists only in ${a === undefined ? 'after' : 'before'}`)
      differences += 1
      continue
    }
    for (const property of Object.keys(a)) {
      if (a[property] !== b[property]) {
        console.log(`${file}: ${key} { ${property} }\n    before: ${a[property]}\n    after:  ${b[property]}`)
        differences += 1
      }
    }
  }
  if (JSON.stringify(before.filters) !== JSON.stringify(after.filters)) {
    console.log(`${file}: SVG filter markup differs`)
    differences += 1
  }
}
for (const file of afterFiles) {
  if (!beforeFiles.includes(file)) {
    console.log(`EXTRA in after: ${file}`)
    differences += 1
  }
}

console.log(`${shots} shots, ${elements} element comparisons, ${differences} differences`)
process.exit(differences === 0 ? 0 : 1)
