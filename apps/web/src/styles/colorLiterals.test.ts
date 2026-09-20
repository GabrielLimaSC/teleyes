/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * S12-01 guard: a color literal (hex, rgb/hsl/..., named color) may only be
 * written in `styles/tokens.css` and `styles/materials.css`. Everything else —
 * component and page stylesheets, `.ts/.tsx`, inline `style={{}}`, `index.html`
 * — must reference a token (`var(--…)`), so a theme only has to redefine tokens.
 * Comments are ignored; test files are not scanned.
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Files allowed to hold literals, each with the reason. */
const ALLOWLIST: Record<string, string> = {
  'src/styles/tokens.css': 'defines the --color-* layer (Dub/CRUD tokens): the source of light values',
  'src/styles/materials.css': 'defines the --plane-* layer and every S12-01 semantic token: the source of light values',
  'public/favicon.svg':
    'standalone static asset; it cannot read the page’s CSS variables, so its own colors live in the file (its dark variant is S12-03/04)',
}

const SCANNED_DIRS = ['src', 'public']
const SCANNED_FILES = ['index.html']
const SCANNED_EXTENSIONS = new Set(['.css', '.ts', '.tsx', '.html', '.svg'])

// The 148 named colors of CSS Color 4 (`transparent`/`currentColor` are keywords, not colors).
const NAMED_COLORS = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond',
  'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue',
  'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey',
  'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue',
  'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro',
  'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred',
  'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral',
  'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon',
  'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime',
  'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple',
  'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue',
  'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff',
  'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown',
  'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray',
  'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet',
  'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
]

const COLOR_LITERAL = new RegExp(
  [
    // #rgb, #rgba, #rrggbb, #rrggbbaa — not an id such as `#nav-glass-refraction`
    String.raw`#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])`,
    // rgb()/rgba()/hsl()/hsla()/hwb()/lab()/lch()/oklab()/oklch()/color()
    String.raw`(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(`,
    // named colors, as a whole word (not `white-space`, not `.foo-red`)
    String.raw`(?<![\w-.#])(?:${NAMED_COLORS.join('|')})(?![\w-])`,
  ].join('|'),
  'g',
)

function stripComments(source: string, extension: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, '')
  if (extension === '.ts' || extension === '.tsx') {
    // `//` line comments, but not the `//` of a URL such as https://…
    return withoutBlock.replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  }
  if (extension === '.html' || extension === '.svg') return withoutBlock.replace(/<!--[\s\S]*?-->/g, '')
  return withoutBlock
}

export function findColorLiterals(source: string, extension: string): string[] {
  return stripComments(source, extension).match(COLOR_LITERAL) ?? []
}

function isTestFile(file: string): boolean {
  return /\.test\.(ts|tsx)$/.test(file)
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function scannedFiles(): string[] {
  const files = [
    ...SCANNED_DIRS.flatMap((dir) => walk(path.join(WEB_ROOT, dir))),
    ...SCANNED_FILES.map((file) => path.join(WEB_ROOT, file)),
  ]
  return files
    .filter((file) => SCANNED_EXTENSIONS.has(path.extname(file)))
    .filter((file) => !isTestFile(file))
    .map((file) => path.relative(WEB_ROOT, file).split(path.sep).join('/'))
}

describe('findColorLiterals (the detector itself)', () => {
  it('finds hex, functional and named colors', () => {
    expect(findColorLiterals('a { color: #fff; }', '.css')).toEqual(['#fff'])
    expect(findColorLiterals('a { color: #1c8a4bcc; }', '.css')).toEqual(['#1c8a4bcc'])
    expect(findColorLiterals('a { background: rgba(0, 0, 0, 0.1); }', '.css')).toEqual(['rgba('])
    expect(findColorLiterals('a { color: hsl(10 20% 30%); }', '.css')).toEqual(['hsl('])
    expect(findColorLiterals('a { color: white; }', '.css')).toEqual(['white'])
    expect(findColorLiterals('a { color: whitesmoke; border-color: rebeccapurple; }', '.css')).toEqual(['whitesmoke', 'rebeccapurple'])
    expect(findColorLiterals('a { background: lightgray; }', '.css')).toEqual(['lightgray'])
    expect(findColorLiterals("const c = { color: '#8a8a92' }", '.ts')).toEqual(['#8a8a92'])
  })

  it('accepts tokens, keywords and non-color lookalikes', () => {
    expect(findColorLiterals('a { color: var(--plane-text-primary); }', '.css')).toEqual([])
    expect(findColorLiterals('a { background: transparent; border-color: currentColor; }', '.css')).toEqual([])
    expect(findColorLiterals('a { white-space: nowrap; filter: url("#nav-glass-refraction"); }', '.css')).toEqual([])
    expect(findColorLiterals('a { border-color: color-mix(in srgb, var(--x) 30%, transparent); }', '.css')).toEqual([])
    expect(findColorLiterals("const c = { color: 'var(--pill-good-dot)' }", '.ts')).toEqual([])
    expect(findColorLiterals('.tab-white { } .tan-x { }', '.css')).toEqual([])
  })

  it('ignores comments', () => {
    expect(findColorLiterals('/* was #f5f5f7 */ a { color: var(--x); }', '.css')).toEqual([])
    expect(findColorLiterals("// was '#fff'\nconst a = 1", '.ts')).toEqual([])
    expect(findColorLiterals("/* #fff */ const a = 1", '.ts')).toEqual([])
    expect(findColorLiterals('<!-- #fff --><p></p>', '.html')).toEqual([])
  })
})

describe('no color literal outside the token files (S12-01)', () => {
  const files = scannedFiles()

  it('scans the real source tree', () => {
    expect(files).toContain('src/pages/RegrasPage.css')
    expect(files).toContain('src/components/deliveryStatus.ts')
    expect(files).toContain('index.html')
    expect(files).not.toContain('src/pages/RegrasPage.test.tsx')
  })

  it('keeps every allowlist entry real and justified', () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(files, `${file} is allowlisted but not scanned`).toContain(file)
      expect(reason.length, `${file} needs a justification`).toBeGreaterThan(20)
    }
  })

  it('has no literal in any other file', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file in ALLOWLIST) continue
      const literals = findColorLiterals(readFileSync(path.join(WEB_ROOT, file), 'utf8'), path.extname(file))
      if (literals.length > 0) offenders.push(`${file}: ${[...new Set(literals)].join(', ')}`)
    }
    expect(offenders, `color literals must be tokens (styles/materials.css):\n${offenders.join('\n')}`).toEqual([])
  })
})
