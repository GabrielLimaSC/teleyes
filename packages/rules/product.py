"""S14-01: deterministic product identity for a promo message.

`product_key` groups matches of "the same product" so price history (F1) and
read-time duplicate grouping (F5) have something stable to aggregate on. It
is deliberately conservative — no fuzzy matching (CLAUDE.md): two posts only
share a key when their product title normalises to the exact same tokens.
When in doubt it fragments (two keys for one product) rather than merging two
different products, because a wrong merge would show one product's price as
another's history.

The title is cut the same way the web card does it
(`apps/web/src/components/matchTitle.ts::productText`: everything before the
first link), then every line is cut at its first price/installment/shipping/
coupon marker, banner-only lines ("🔥 OFERTA RELÂMPAGO 🔥") are dropped, and
the rest goes through `normalize_text`. The rule-term cut of `cardTitle` is
intentionally not ported: it depends on which rule matched, and a product key
must be the same whichever rule caught the message.
"""

import re
import unicodedata

from packages.rules.normalize import normalize_text

_FIRST_LINK_RE = re.compile(r"https?://", re.IGNORECASE)

# Everything from the first of these markers to the end of a line is price,
# payment or shipping talk, never product name. A line that *starts* with one
# ("💵 R$ 5.749,00 no pix") is dropped entirely.
_NOISE_MARKER_RE = re.compile(
    r"(?:\b(?:r|us)\s?)?\$"  # R$ 5.749 / US$ 99
    r"|\b\d{1,2}\s*x\s*(?:de\b|r\$|sem\s+juros)"  # 10x de / 12x R$ / 10x sem juros
    r"|\bsem\s+juros\b"
    r"|(?<!\w)[àa]\s*vista\b"
    r"|\bpix\b"
    r"|\bboleto\b"
    r"|\bparcelad[oa]s?\b"
    r"|\bfrete\b"
    r"|\bcupo[mn]s?\b"
    r"|\bdesconto\b"
    r"|\b\d{1,3}\s*%\s*off\b"
    r"|\b\d{1,3}(?:\.\d{3})+(?:,\d{2})?\b"  # 5.749 / 5.749,00 (never a bare model number)
    r"|\b\d+,\d{2}\b",  # 639,00
    re.IGNORECASE,
)

# A line made *only* of these (normalised) words is a banner or call to
# action, not part of the product name.
_BANNER_TOKENS = frozenset(
    (
        "oferta ofertas promocao promocoes promo relampago imperdivel baixou baixa caiu "
        "queda corre corra urgente achado achadinho bug voltou precinho menor preco "
        "historico estoque disponivel limitado ultimas unidades compre comprar aqui link "
        "acesse confira garanta clique ja agora hoje so apenas o a os as seu sua no na de "
        "do da para pelo pela e site loja top valor"
    ).split()
)

# Hype words stripped only from the very start of the key.
_LEADING_HYPE_TOKENS = frozenset(
    (
        "oferta ofertas promocao promo relampago imperdivel baixou corre corra urgente "
        "achado achadinho bug voltou precinho"
    ).split()
)

# Connectors left dangling at the end once a price was cut ("... por R$ 99").
_TRAILING_CONNECTOR_TOKENS = frozenset(
    (
        "por de ou apenas so com no na em e a o pelo pela ate valor preco sai saindo "
        "custando partir"
    ).split()
)

_EDGE_PUNCTUATION = " \t-–—:|•*·!?.,;/\\()[]{}\"'"
_WHITESPACE_RE = re.compile(r"\s+")

MAX_KEY_LENGTH = 200


def product_text(message_text: str) -> str:
    """Python port of `matchTitle.ts::productText`: cut at the first link.

    A link at (or near) the very start would leave nothing, so the full text
    is kept in that case — same fallback as the web card.
    """
    link = _FIRST_LINK_RE.search(message_text)
    if link is None:
        return message_text
    before = message_text[: link.start()].rstrip()
    return before if before else message_text


def _strip_symbols(text: str) -> str:
    """Drop emoji/pictographs, variation selectors and zero-width joiners."""
    kept = [
        char
        for char in unicodedata.normalize("NFC", text)
        if unicodedata.category(char) not in {"So", "Sk", "Cf", "Co", "Cs"}
        and char not in {"\ufe0e", "\ufe0f"}
    ]
    return "".join(kept)


def _clean_line(line: str) -> str | None:
    """The product part of one line, or `None` when nothing product-like is left."""
    if _FIRST_LINK_RE.search(line):
        return None
    marker = _NOISE_MARKER_RE.search(line)
    kept = line[: marker.start()] if marker is not None else line
    kept = _WHITESPACE_RE.sub(" ", _strip_symbols(kept)).strip(_EDGE_PUNCTUATION)
    tokens = normalize_text(kept).split()
    if not tokens or all(token in _BANNER_TOKENS for token in tokens):
        return None
    return kept


def product_title(message_text: str) -> str | None:
    """Human-readable product title (original case), or `None` if none is found."""
    lines = [_clean_line(line) for line in product_text(message_text).splitlines()]
    kept = [line for line in lines if line is not None]
    if not kept:
        return None
    return " ".join(kept)


def _trim_edges(tokens: list[str]) -> list[str]:
    start, end = 0, len(tokens)
    while start < end and tokens[start] in _LEADING_HYPE_TOKENS:
        start += 1
    while end > start and tokens[end - 1] in _TRAILING_CONNECTOR_TOKENS:
        end -= 1
    return tokens[start:end]


def product_key(message_text: str) -> str | None:
    """Stable, URL-safe product identity (`palit-rtx-5070-ti-16gb`) or `None`.

    Deterministic: same input, same key, forever — changing this function
    changes the identity of existing rows, so it needs a new backfill
    migration whenever it changes.
    """
    title = product_title(message_text)
    if title is None:
        return None
    tokens = _trim_edges(normalize_text(title).split())
    kept: list[str] = []
    length = 0
    for token in tokens:
        extra = len(token) + (1 if kept else 0)
        if length + extra > MAX_KEY_LENGTH:
            break
        kept.append(token)
        length += extra
    return "-".join(kept) if kept else None
