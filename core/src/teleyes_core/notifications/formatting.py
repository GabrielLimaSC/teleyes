"""S14-02: pt-BR currency text for bot messages.

Written by hand instead of relying on the stdlib `locale` module, which
needs a `pt_BR` locale actually installed on the host to behave — not
guaranteed inside Docker/CI. Matches the frontend's own formatting
(`apps/web/src/components/MatchCard.tsx`'s
`toLocaleString('pt-BR', {style: 'currency', currency: 'BRL'})`), so a price
reads the same in the panel and in a Telegram message.
"""


def format_price_cents(cents: int) -> str:
    """`format_price_cents(224900) == "R$ 2.249,00"`."""
    sign = "-" if cents < 0 else ""
    reais, remaining_cents = divmod(abs(cents), 100)
    grouped_reais = f"{reais:,}".replace(",", ".")
    return f"{sign}R$ {grouped_reais},{remaining_cents:02d}"
