import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { savingsReport } from './fixtures'
import { ResultsCardPanel } from './ResultsCardPanel'

const dated = () => {
  const base = savingsReport()
  const [a, b, c] = base.items
  return savingsReport({
    items: [
      { ...a!, purchased_at: '2026-10-20T15:00:00Z' },
      { ...b!, purchased_at: '2026-09-10T15:00:00Z' },
      { ...c!, purchased_at: '2026-04-01T15:00:00Z' },
    ],
  })
}

const previewText = () =>
  decodeURIComponent(screen.getByRole('img', { name: 'Prévia do cartão de resultados' }).getAttribute('src')!)

const nav = navigator as unknown as Record<string, unknown>

describe('ResultsCardPanel (S25-F5)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: new Headers() }))
    // jsdom cannot rasterise the SVG: pretend the image loads and the canvas works.
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null
        set src(_value: string) {
          queueMicrotask(() => this.onload?.())
        }
      },
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => {} } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['x'], { type: 'image/png' })))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete nav.share
    delete nav.canShare
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })

  it('changes the numbers when the period changes', async () => {
    const user = userEvent.setup()
    render(<ResultsCardPanel report={dated()} onClose={() => {}} />)
    expect(previewText()).toContain('Relatório de economia · Tudo')
    expect(previewText()).toContain('Cabo HDMI')

    await user.click(screen.getByRole('radio', { name: 'Este mês' }))
    expect(previewText()).toContain('Relatório de economia · Este mês')
    expect(previewText()).toContain('Placa-mãe B850M')
    expect(previewText()).not.toContain('SSD NVMe')
    expect(previewText()).not.toContain('Cabo HDMI')
  })

  it('shares the file when the browser supports it', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    nav.share = share
    nav.canShare = () => true
    const user = userEvent.setup()
    render(<ResultsCardPanel report={dated()} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Compartilhar' }))
    await vi.waitFor(() => expect(share).toHaveBeenCalledOnce())
    expect(share.mock.calls[0]![0].files[0].name).toBe('teleyes-economia.png')
  })

  it('falls back to copying the image and says so', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    // userEvent.setup() installs its own clipboard stub; ours goes in after it.
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
    vi.stubGlobal('ClipboardItem', class {})
    render(<ResultsCardPanel report={dated()} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Compartilhar' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Imagem copiada')
    expect(write).toHaveBeenCalledOnce()
  })

  it('hides Compartilhar when neither share nor clipboard exist', () => {
    render(<ResultsCardPanel report={dated()} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Compartilhar' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Baixar imagem (PNG)' })).toBeEnabled()
  })
})
