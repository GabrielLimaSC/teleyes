import { describe, expect, it } from 'vitest'
import { csvField } from './csv'

describe('csvField', () => {
  it('leaves ordinary text alone', () => {
    expect(csvField('Placa de vídeo RTX 5070')).toBe('Placa de vídeo RTX 5070')
    expect(csvField('https://loja.example/p?a=1')).toBe('https://loja.example/p?a=1')
  })

  it('quotes fields with commas, quotes and line breaks', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('diz "oi"')).toBe('"diz ""oi"""')
    expect(csvField('linha 1\nlinha 2')).toBe('"linha 1\nlinha 2"')
  })

  it.each(['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])(
    'neutralizes the formula start %j with a leading apostrophe',
    (value) => {
      expect(csvField(value).replace(/^"/, '').startsWith("'")).toBe(true)
    },
  )

  it('neutralizes a formula that also needs quoting', () => {
    expect(csvField('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"')
  })
})
