import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MatchCard } from './MatchCard'
import type { Match, Recipient, Rule, Source } from '../api/types'

const rule: Rule = {
  id: 1,
  name: 'iPhone até R$ 4.000',
  include_terms: 'iphone',
  exclude_terms: null,
  max_price_cents: 400_000,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
  lowest_price_cents: null,
}

const source: Source = {
  id: 1,
  name: 'Urubu das Promoções',
  telegram_chat_id: '-1001',
  active: true,
  created_at: '2026-01-01T00:00:00Z',
}

const recipients: Recipient[] = [
  {
    id: 1,
    name: 'Gabriel',
    telegram_chat_id: '999',
    allowlisted: true,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
]

function buildMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 1,
    source_id: 1,
    rule_id: 1,
    message_text: 'Promoção iPhone 15 128GB por R$ 3.899',
    price_cents: 389_900,
    price_cash_cents: null,
    price_card_cents: null,
    message_link: null,
    matched_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    deliveries: [],
    is_lowest_price_ever: false,
    grouped_source_ids: null,
    ...overrides,
  }
}

describe('MatchCard', () => {
  it('renders product, price, source/rule metadata and status', () => {
    render(
      <MatchCard
        match={buildMatch({ deliveries: [{ id: 1, recipient_id: 1, status: 'sent', delivered_at: '2026-01-01T00:00:01Z', created_at: '2026-01-01T00:00:01Z' }] })}
        rule={rule}
        source={source}
        recipients={recipients}
      />,
    )

    // S9-06/S10-02: no blank line (`\n\n`) anywhere in this text, so the
    // cut never fires — full text stays, same shape as the real CMdias/
    // S8-02 case (see the dedicated S9-06/S10-02 tests below for both
    // sides of the gate).
    expect(screen.getByText('Promoção iPhone 15 128GB por R$ 3.899')).toBeInTheDocument()
    expect(screen.getByText('R$ 3.899,00')).toBeInTheDocument()
    expect(screen.getByText(/Urubu das Promoções/)).toBeInTheDocument()
    expect(screen.getByText(/iPhone até R\$ 4\.000/)).toBeInTheDocument()
    expect(screen.getByText(/Gabriel/)).toBeInTheDocument()
    expect(screen.getByText('Entregue')).toBeInTheDocument()
  })

  it('renders a long product name in full, never shortened (S7-02)', () => {
    const longName =
      'Placa de vídeo NVIDIA GeForce RTX 5060 Ti 16GB GDDR7 com resfriamento triplo e RGB ' +
      'endereçável, edição especial gamer completa da linha'
    render(
      <MatchCard
        match={buildMatch({ message_text: longName })}
        rule={rule}
        source={source}
        recipients={recipients}
      />,
    )

    // A CSS-only truncation (text-overflow: ellipsis) never touches the DOM
    // text itself — so this alone wouldn't have caught the S7-02 bug. The
    // real regression check is `.match-card__product` no longer setting
    // `white-space: nowrap`/`text-overflow: ellipsis` at all (see
    // MatchCard.css and the Playwright coverage in e2e/states.spec.ts, which
    // exercises the actual rendered layout in a real browser).
    expect(screen.getByText(longName)).toBeInTheDocument()
  })

  it('falls back to raw ids when rule/source lookups are missing', () => {
    render(<MatchCard match={buildMatch()} rule={undefined} source={undefined} recipients={[]} />)

    expect(screen.getByText(/Fonte: #1/)).toBeInTheDocument()
    expect(screen.getByText(/Regra: #1/)).toBeInTheDocument()
  })

  it('shows a price placeholder when no price was extracted', () => {
    render(
      <MatchCard match={buildMatch({ price_cents: null })} rule={rule} source={source} recipients={[]} />,
    )

    expect(screen.getByText('Preço não identificado')).toBeInTheDocument()
  })

  it('has no Aurora Glow ring or label by default (no real price-history data yet)', () => {
    const { container } = render(
      <MatchCard match={buildMatch()} rule={rule} source={source} recipients={[]} />,
    )

    expect(container.querySelector('.match-card--aurora')).not.toBeInTheDocument()
    expect(screen.queryByText('Menor preço já visto')).not.toBeInTheDocument()
  })

  it('renders the Aurora Glow ring and label when isLowestPriceEver is true', () => {
    const { container } = render(
      <MatchCard
        match={buildMatch()}
        rule={rule}
        source={source}
        recipients={[]}
        isLowestPriceEver
      />,
    )

    expect(container.querySelector('.match-card--aurora')).toBeInTheDocument()
    expect(screen.getByText('Menor preço já visto')).toBeInTheDocument()
  })

  it('shows both prices when the message had explicit cash/card anchors (S7-05)', () => {
    render(
      <MatchCard
        match={buildMatch({ price_cash_cents: 389_900, price_card_cents: 419_900 })}
        rule={rule}
        source={source}
        recipients={[]}
      />,
    )

    expect(screen.getByText('À vista: R$ 3.899,00')).toBeInTheDocument()
    expect(screen.getByText('Cartão: R$ 4.199,00')).toBeInTheDocument()
    // The single-price paragraph never renders alongside the split prices.
    expect(screen.queryByText('R$ 3.899,00', { selector: '.match-card__price' })).not.toBeInTheDocument()
  })

  it('shows only the single price when no cash/card split was found', () => {
    render(
      <MatchCard
        match={buildMatch({ price_cents: 389_900, price_cash_cents: null, price_card_cents: null })}
        rule={rule}
        source={source}
        recipients={[]}
      />,
    )

    expect(screen.getByText('R$ 3.899,00')).toBeInTheDocument()
    expect(screen.queryByText(/À vista:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Cartão:/)).not.toBeInTheDocument()
  })

  it('shows the match date/time (S7-10)', () => {
    render(
      <MatchCard
        match={buildMatch({ matched_at: '2026-03-05T14:30:00Z' })}
        rule={rule}
        source={source}
        recipients={[]}
      />,
    )

    expect(screen.getByText(new Date('2026-03-05T14:30:00Z').toLocaleString('pt-BR'))).toBeInTheDocument()
  })

  it('has no "Abrir promoção" link when the match has no real link yet (S7-10)', () => {
    render(
      <MatchCard match={buildMatch({ message_link: null })} rule={rule} source={source} recipients={[]} />,
    )

    expect(screen.queryByRole('link', { name: 'Abrir promoção' })).not.toBeInTheDocument()
  })

  it('opens the real promotion link in a new tab when present (S7-10)', () => {
    render(
      <MatchCard
        match={buildMatch({ message_link: 'https://t.me/c/123456/7' })}
        rule={rule}
        source={source}
        recipients={[]}
      />,
    )

    const link = screen.getByRole('link', { name: 'Abrir promoção' })
    expect(link).toHaveAttribute('href', 'https://t.me/c/123456/7')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('has no "Visto em" line when nothing grouped with it (S7-11)', () => {
    render(
      <MatchCard
        match={buildMatch({ grouped_source_ids: null })}
        rule={rule}
        source={source}
        recipients={[]}
      />,
    )

    expect(screen.queryByText(/Visto em:/)).not.toBeInTheDocument()
  })

  it('shows "Visto em" with the resolved names of every grouped source (S7-11)', () => {
    render(
      <MatchCard
        match={buildMatch({ grouped_source_ids: [2, 3] })}
        rule={rule}
        source={source}
        recipients={[]}
        groupedSourceNames={['CMdias', 'Wolf Ofertas']}
      />,
    )

    expect(screen.getByText('Visto em: CMdias, Wolf Ofertas')).toBeInTheDocument()
  })

  it('shows only the text before the first link, dropping URLs and footer (S8-02)', () => {
    const realCmdiasText =
      '🔥 RTX 5070 ... 💵 R$ 4.516 🎫 Resgatem o cupom de R$ 90 OFF: ' +
      'https://s.shopee.com.br/abc ⚠️Cupom, preço e estoque por tempo limitado. Anúncio'
    render(
      <MatchCard
        match={buildMatch({ message_text: realCmdiasText })}
        rule={rule}
        source={source}
        recipients={[]}
      />,
    )

    expect(
      screen.getByText('🔥 RTX 5070 ... 💵 R$ 4.516 🎫 Resgatem o cupom de R$ 90 OFF:'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/shopee\.com\.br/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Anúncio/)).not.toBeInTheDocument()
  })

  it('shows the full text unchanged when the message has no link (S8-02)', () => {
    const noLinkText = 'RTX 5070 por R$ 4.516, sem link nenhum aqui'
    render(
      <MatchCard
        match={buildMatch({ message_text: noLinkText })}
        rule={rule}
        source={source}
        recipients={[]}
      />,
    )

    expect(screen.getByText(noLinkText)).toBeInTheDocument()
  })

  it('falls back to the full text when the link sits at the very start (S8-02)', () => {
    const linkFirstText = 'https://s.shopee.com.br/abc RTX 5070 por R$ 4.516'
    render(
      <MatchCard
        match={buildMatch({ message_text: linkFirstText })}
        rule={rule}
        source={source}
        recipients={[]}
      />,
    )

    // Truncating here would leave an empty card — showing everything beats
    // showing nothing, same principle as S7-02's "never lose information".
    expect(screen.getByText(linkFirstText)).toBeInTheDocument()
  })

  it('never cuts a word mid-way right before the link (S8-02)', () => {
    const text = 'RTX5070promocao https://s.shopee.com.br/abc'
    render(
      <MatchCard match={buildMatch({ message_text: text })} rule={rule} source={source} recipients={[]} />,
    )

    expect(screen.getByText('RTX5070promocao')).toBeInTheDocument()
  })

  it('cuts the title right after the rule term when a blank line follows it (S10-02, PC DO FAFA real id 91)', () => {
    // Real production message (match id 91, fonte PC DO FAFA PROMOÇÕES,
    // regra "RTX 5070 Ti") — the S9-06 position-based heuristic (>= 50%)
    // never fired on this one (term ends at ~33%), which is what motivated
    // S10-02: recalibrated against 87 real matches, a blank line (`\n\n`)
    // after the term turned out to be the real, consistently-present signal
    // position never was. Full real text, not a paraphrase.
    const rtxRule: Rule = { ...rule, name: 'RTX 5070 Ti', include_terms: 'rtx 5070 ti,5070 ti' }
    const realTitle =
      '👌 Placa de Video Geforce Nvidia Palit Rtx 5070 Ti 16Gb Gamingpro-S Gdr7 256Bit 3-Dp Hd\n\n' +
      '💲 Valor: R$6.991,08 8% desconto no Pix\n\n👉 Resgate o cupom\n' +
      '👀 https://pcdofafa.com.br/p/shopee/jb6gwx'
    render(
      <MatchCard
        match={buildMatch({ message_text: realTitle })}
        rule={rtxRule}
        source={source}
        recipients={[]}
      />,
    )

    expect(
      screen.getByText('👌 Placa de Video Geforce Nvidia Palit Rtx 5070 Ti'),
    ).toBeInTheDocument()
  })

  it('does not cut when no blank line follows the rule term (S9-06, CMdias — no regression on S8-02)', () => {
    // Same real message the S8-02 tests use (fonte CMdias) — no `\n\n`
    // anywhere in this specific fixture (unlike real CMdias messages pulled
    // from production for S10-02, which do have one — see the dedicated
    // real-CMdias test below). Cutting here would destroy the S8-02
    // done_when, so this must stay untouched — reusing the S8-02 fixture/
    // expectation rather than duplicating a new one, per the TASKS.md note.
    const cmdiasRule: Rule = { ...rule, name: 'RTX 5070', include_terms: 'rtx 5070' }
    const realCmdiasText =
      '🔥 RTX 5070 ... 💵 R$ 4.516 🎫 Resgatem o cupom de R$ 90 OFF: ' +
      'https://s.shopee.com.br/abc ⚠️Cupom, preço e estoque por tempo limitado. Anúncio'
    render(
      <MatchCard
        match={buildMatch({ message_text: realCmdiasText })}
        rule={cmdiasRule}
        source={source}
        recipients={[]}
      />,
    )

    expect(
      screen.getByText('🔥 RTX 5070 ... 💵 R$ 4.516 🎫 Resgatem o cupom de R$ 90 OFF:'),
    ).toBeInTheDocument()
  })

  it('cuts a real CMdias message once real paragraph structure is present (S10-02)', () => {
    // Real production message (match id 88, fonte CMdias, regra "RTX
    // 5060") — unlike the single-line S8-02 unit-test fixture above, real
    // CMdias messages do have a `\n\n` separating the product name from the
    // price/coupon block, so this one now cuts too (it didn't under S9-06's
    // position gate either, same ~38% shape as the fixture above it).
    const cmdiasRule: Rule = { ...rule, name: 'RTX 5060', include_terms: 'rtx5060, rtx 5060' }
    const realCmdiasText =
      '🔥 Placa de Vídeo NVIDIA GeForce MSI RTX5060 8GB GDDR7 128BITS SHADOW 2X\n\n' +
      '💵 R$ 2.542\n\n🎟 Resgate cupom de 100 OFF:\nhttps://s.shopee.com.br/2gB9kYURhz'
    render(
      <MatchCard
        match={buildMatch({ message_text: realCmdiasText })}
        rule={cmdiasRule}
        source={source}
        recipients={[]}
      />,
    )

    expect(
      screen.getByText('🔥 Placa de Vídeo NVIDIA GeForce MSI RTX5060'),
    ).toBeInTheDocument()
  })

  it('matches the rule term case/accent-insensitively (S9-06)', () => {
    const accentRule: Rule = { ...rule, include_terms: 'promoção' }
    render(
      <MatchCard
        match={buildMatch({ message_text: 'Achado RTX 5070 na PROMOÇÃO\n\nReal hoje mesmo, aproveite' })}
        rule={accentRule}
        source={source}
        recipients={[]}
      />,
    )

    expect(screen.getByText('Achado RTX 5070 na PROMOÇÃO')).toBeInTheDocument()
  })

  it('never anchors the cut on a blank line that sits before the rule term (S10-02)', () => {
    // Real production message (match id 62, fonte CMdias) has a banner
    // line ("ESTOQUE DISPONIVEL!!!") *before* the product name, with its
    // own blank line separating them — cutting at the first `\n\n` in the
    // text (a simpler rule considered and rejected for S10-02) would chop
    // the product name off entirely. The cut always anchors on the rule
    // term's own position; the blank-line check only looks *after* it.
    const rtxRule: Rule = { ...rule, name: 'RTX 5060', include_terms: 'rtx5060, rtx 5060' }
    const realText =
      'ESTOQUE DISPONIVEL!!!\n\n\n🔥 Placa de Vídeo NVIDIA GeForce INNO3D RTX5060 8GB TWIN X2 OC V2 GDDR7\n\n' +
      '💵 R$2.299,08\n\n🎟️ Cupom: `SH0PP1NG`'
    render(
      <MatchCard match={buildMatch({ message_text: realText })} rule={rtxRule} source={source} recipients={[]} />,
    )

    // testing-library's default text matcher collapses whitespace (incl.
    // newlines) before comparing — the DOM text itself still has the real
    // `\n\n\n`, only this assertion's expected string is pre-collapsed.
    expect(
      screen.getByText('ESTOQUE DISPONIVEL!!! 🔥 Placa de Vídeo NVIDIA GeForce INNO3D RTX5060'),
    ).toBeInTheDocument()
  })

  it('shows the full text when the rule term is not found in the message (S9-06)', () => {
    const unrelatedRule: Rule = { ...rule, include_terms: 'placa-mae b850' }
    const text = 'RTX 5070 por R$ 4.516, sem termo da regra aqui'
    render(
      <MatchCard
        match={buildMatch({ message_text: text })}
        rule={unrelatedRule}
        source={source}
        recipients={[]}
      />,
    )

    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('shows the full text when there is no rule at all (S9-06)', () => {
    const text = 'RTX 5070 por R$ 4.516, sem regra resolvida'
    render(
      <MatchCard match={buildMatch({ message_text: text })} rule={undefined} source={source} recipients={[]} />,
    )

    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('leaves the text unchanged when the rule term sits at the very end, no blank line after it (S9-06)', () => {
    const text = 'Promoção imperdível de iPhone'
    render(
      <MatchCard match={buildMatch({ message_text: text })} rule={rule} source={source} recipients={[]} />,
    )

    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('never cuts mid-word when the rule term is a substring of a longer word (S9-06)', () => {
    const numericRule: Rule = { ...rule, include_terms: '5070' }
    const text = 'Promoção RTX 50700X\n\npor R$ 4.516'
    render(
      <MatchCard match={buildMatch({ message_text: text })} rule={numericRule} source={source} recipients={[]} />,
    )

    // The term match ends mid-word (inside "50700X"), so the cut extends to
    // the next whitespace instead of splitting the word — "50700X" stays
    // whole, everything after that word is still dropped.
    expect(screen.getByText('Promoção RTX 50700X')).toBeInTheDocument()
  })

  it('does not reintroduce the link when the term only appears after it (S9-06, combined with S8-02)', () => {
    // The S8-02 "link near the start" fallback shows the whole message
    // (including the link) rather than an empty card — the rule-term cut
    // must never fire on top of that, or the link would resurface.
    const linkFirstRule: Rule = { ...rule, include_terms: 'rtx 5070' }
    const text = 'https://s.shopee.com.br/abc RTX 5070 por R$ 4.516'
    render(
      <MatchCard match={buildMatch({ message_text: text })} rule={linkFirstRule} source={source} recipients={[]} />,
    )

    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('shows a tooltip with the untruncated text when the S9-06/S10-02 cut fires (S9-02)', () => {
    const rtxRule: Rule = { ...rule, name: 'RTX 5070 Ti', include_terms: 'rtx 5070 ti,5070 ti' }
    const realTitle =
      '👌 Placa de Video Geforce Nvidia Palit Rtx 5070 Ti 16Gb Gamingpro-S Gdr7 256Bit 3-Dp Hd\n\n' +
      '💲 Valor: R$6.991,08 8% desconto no Pix'
    render(
      <MatchCard
        match={buildMatch({ message_text: realTitle })}
        rule={rtxRule}
        source={source}
        recipients={[]}
      />,
    )

    // toHaveTextContent normalizes the received text but not the expected
    // string, so the `\n\n` here is pre-collapsed to match it.
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      '👌 Placa de Video Geforce Nvidia Palit Rtx 5070 Ti 16Gb Gamingpro-S Gdr7 256Bit 3-Dp Hd ' +
        '💲 Valor: R$6.991,08 8% desconto no Pix',
    )
  })

  it('has no tooltip when the title was not truncated (S9-02)', () => {
    render(
      <MatchCard
        match={buildMatch({ message_text: 'Promoção iPhone 15 128GB por R$ 3.899' })}
        rule={rule}
        source={source}
        recipients={[]}
      />,
    )

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
