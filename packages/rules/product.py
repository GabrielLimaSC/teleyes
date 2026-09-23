"""S14-01: deterministic product identity for a promo message.

`product_key` groups matches of "the same product" so price history (F1) and
read-time duplicate grouping (F5) have something stable to aggregate on. It
is deliberately conservative — no fuzzy matching (CLAUDE.md).

Recalibration (S14-01 follow-up): the key used to be the whole title
normalised, so every store's own wording of specs, part codes and CTA
footers ("104mb 4.7ghz 8 nucleos", "100-100001084WOF", "resgate todos os")
fragmented the same real product into a dozen keys. The key is now a "model
fingerprint": brand (from a small explicit allowlist) + model-code tokens +
line/variant words, in that canonical order, picked from the first product
line that actually contains a model code (skipping hype lines and thin
category tags before it). Capacity, frequency, bus/socket, port and count
specs are stripped because they vary post to post without identifying a
different product; brand, model code and line/variant words never are,
because mixing those would show one product's price as another's history.
When in doubt this still fragments (two keys for one product) rather than
merging two different products.

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

# --- model fingerprint (S14-01 recalibration) --------------------------------
#
# Everything below turns one already-cleaned product line into
# (brand, model-code tokens, line/variant tokens). Order of operations
# matters: specs are stripped from the raw (pre-`normalize_text`) line so
# decimal points and unit spacing ("4.7GHz", "192 bits") are still visible,
# *then* the survivors are tokenised and classified.

# GPU/chip series written glued ("rtx5070ti", "rx9070xt") are split back into
# "rtx 5070 ti" so they tokenise the same as the spaced form.
_SERIES_RE = re.compile(
    # The separator before a suffix is grouped *with* the suffix so it is
    # only consumed when a suffix actually follows — otherwise "RTX 5070
    # Shadow" (no suffix) would eat the space before the next word and glue
    # it to the number ("5070Shadow").
    r"\b(rtx|gtx|rx|arc)[\s-]*(\d{3,4})(?:[\s-]*(ti|super|xt|xtx)\b)?",
    re.IGNORECASE,
)
_SERIES_PREFIX_TOKENS = frozenset("rtx gtx rx arc".split())
_SERIES_SUFFIX_TOKENS = frozenset("ti super xt xtx".split())

_LIAN_LI_RE = re.compile(r"\blian\s*li\b", re.IGNORECASE)

_MULTIPLIER_RE = re.compile(r"^\d+x$")
_UNIT_SUFFIX_RE = re.compile(r"^\d+(?:gb|mb|tb|kb|w|v|bit|bits)$")
_FREQ_SUFFIX_RE = re.compile(r"^\d+(?:ghz|mhz|hz)$")
_BARE_CHIPSET_RE = re.compile(r"^[ab]\d{3}$")  # "B850"/"A620": the chipset generation,
# not the board ("B850M", "A620AM" keep their trailing letters and are unaffected).

# Words a bare digit is glued to across a space instead of a real separator
# ("8 MB", "16 Threads", "AM5 100 100001084Wof") — store copy-paste is
# inconsistent about hyphens/dots, so these are matched at the token level
# (after `normalize_text` has already folded accents and case) instead of
# with a punctuation-sensitive regex on the raw line.
_UNIT_WORDS = frozenset("gb mb tb kb w v bit bits".split())
_FREQ_UNIT_WORDS = frozenset("ghz mhz hz".split())
_COUNT_WORDS = frozenset("nucleo nucleos core cores thread threads porta portas".split())


def _is_code_fragment(token: str) -> bool:
    # A token with a recognised meaning of its own (a capacity/frequency
    # spec, a bus/socket/port word, a fan/cooler multiplier like "2x") is
    # never vendor-SKU noise, even though it is just as alnum-mixed as one
    # ("8gb", "4800mhz", "ddr5", "2x").
    if _UNIT_SUFFIX_RE.match(token) or _FREQ_SUFFIX_RE.match(token) or _MULTIPLIER_RE.match(token):
        return False
    if token in _BUS_SOCKET_TOKENS or token in _PORT_TOKENS:
        return False
    has_alpha = any(char.isalpha() for char in token)
    has_digit = any(char.isdigit() for char in token)
    if has_alpha and has_digit:
        return True
    return token.isdigit() and 2 <= len(token) <= 3


def _drop_part_code_runs(tokens: list[str]) -> list[str]:
    """Drop runs of 2+ consecutive alnum-mixed tokens: long vendor part codes
    ("100-100001084WOF", "90-MXBU40-A0UAYZ", "912-V532",
    "NE75070019K9-GB2050S") chain several digit/letter groups this way,
    whether the source used a hyphen or a bare space between them. A real
    model code ("9800x3d", "b840m", "a620am") never sits directly next to
    another code-shaped token — only ordinary words — so a lone one survives.
    """
    result: list[str] = []
    index, total = 0, len(tokens)
    while index < total:
        if _is_code_fragment(tokens[index]):
            end = index
            while end < total and _is_code_fragment(tokens[end]):
                end += 1
            if end - index >= 2:
                index = end
                continue
        result.append(tokens[index])
        index += 1
    return result


def _strip_unit_and_count_tokens(tokens: list[str], *, keep_capacity: bool) -> list[str]:
    """Drop capacity/frequency/count-phrase noise from a token list.

    Must run *before* `_drop_part_code_runs`: a decimal frequency written
    with spaces instead of a decimal point ("5.2 GHz" -> "5", "2", "ghz") or
    a capacity written as two words ("104 MB" -> "104", "mb") is a run of
    plain-looking, alnum-only tokens that would otherwise sit right next to
    a real model code ("9800X3D 104 MB...") and get swept up with it by the
    part-code-run heuristic. Consuming known spec shapes first means only
    genuine vendor-SKU fragments are left for that pass to find.

    `keep_capacity` skips the capacity and frequency branches only — the
    recovery pass for a branded product with no other model code (see
    `_fingerprint`). Core/thread/port counts are never useful identity
    signal either way, so they are always dropped.
    """
    result: list[str] = []
    index, total = 0, len(tokens)
    while index < total:
        token = tokens[index]
        following = tokens[index + 1] if index + 1 < total else None
        after_following = tokens[index + 2] if index + 2 < total else None
        if token == "m" and following == "2":  # "M.2" / "M 2"
            index += 2
            continue
        if token == "m" and following in ("atx", "matx"):  # "M-ATX" split by the hyphen
            index += 2
            continue
        if _MULTIPLIER_RE.match(token):  # "2x", "3x": a fan/cooler count, not a model code
            index += 1
            continue
        # A decimal spec split across three tokens by a space standing in
        # for the decimal point ("5.2 GHz" -> "5", "2", "ghz").
        if (
            not keep_capacity
            and token.isdigit()
            and following is not None
            and following.isdigit()
            and after_following is not None
            and (after_following in _UNIT_WORDS or after_following in _FREQ_UNIT_WORDS)
        ):
            index += 3
            continue
        if token.isdigit() and following is not None:
            if len(token) <= 2 and (following in _COUNT_WORDS or following in _PORT_TOKENS):
                index += 2
                continue
            if len(token) <= 2 and following.isdigit() and len(following) == 3:
                index += 2  # stray "R$ 6.991" leftover
                continue
            if not keep_capacity and len(token) <= 4 and (
                following in _UNIT_WORDS
                or following in _FREQ_UNIT_WORDS
                or _UNIT_SUFFIX_RE.match(following)
                or _FREQ_SUFFIX_RE.match(following)
            ):
                index += 2
                continue
        if not keep_capacity and (_UNIT_SUFFIX_RE.match(token) or _FREQ_SUFFIX_RE.match(token)):
            index += 1
            continue
        if _BARE_CHIPSET_RE.match(token):
            index += 1
            continue
        result.append(token)
        index += 1
    return result


def _strip_spec_tokens(tokens: list[str], *, keep_capacity: bool) -> list[str]:
    """Drop capacity/frequency/count-phrase/part-code noise from a token list."""
    tokens = _strip_unit_and_count_tokens(tokens, keep_capacity=keep_capacity)
    return _drop_part_code_runs(tokens)

# Chip makers: sometimes in the title, sometimes not, never the identity of
# the specific board/kit being sold. Never a "brand" slot.
_CHIP_MAKER_TOKENS = frozenset("amd nvidia intel geforce radeon".split())

# Small, explicit allowlist of board/memory/PSU manufacturers (CLAUDE.md: no
# fuzzy matching, so this only grows by adding names, never by guessing).
_BRAND_TOKENS = frozenset(
    "palit msi asus gigabyte asrock inno3d zotac galax pny sapphire powercolor xfx "
    "biostar corsair kingston memtech xpg adata husky redragon pcyes gamdias lianli".split()
)

# Product-type / connector / generic descriptor words: present or absent
# without changing which product this is.
_GENERIC_DISCARD_TOKENS = frozenset(
    "placa video mae processador memoria ram gamer desktop oc matx micro atx chipset "
    "para ryzen com sem cooler integrado de da do das dos e cache kit und unidade "
    "unidades geracao serie modelo tipo original graphics socket".split()
)
_BUS_SOCKET_TOKENS = frozenset(
    "ddr5 ddr4 ddr3 gddr7 gddr6x gddr6 gdr7 am5 am4 am6 lga1700 lga1200 lga1851 "
    "pcie pcie3 pcie4 pcie5 nvme uatx itx m2".split()
)
_PORT_TOKENS = frozenset("dp hdmi hd vga usb rgb displayport dvi".split())
_FOOTER_DISCARD_TOKENS = frozenset(
    "resgate resgatem resgatar link produto produtos anuncio amazon kabum usem use "
    "confira aproveite corra garanta acesse clique compre comprar".split()
)
_MARKETING_FILLER_TOKENS = frozenset("max turbo ultra performance nova novo lacrado".split())

_DROP_TOKEN_SETS = (
    _CHIP_MAKER_TOKENS,
    _GENERIC_DISCARD_TOKENS,
    _BUS_SOCKET_TOKENS,
    _PORT_TOKENS,
    _FOOTER_DISCARD_TOKENS,
    _MARKETING_FILLER_TOKENS,
    _BANNER_TOKENS,
    _LEADING_HYPE_TOKENS,
    _TRAILING_CONNECTOR_TOKENS,
)

# Line/variant words worth keeping: they are what tells two boards with the
# same brand and chip apart (GamingPro vs Inspire, Challenger vs Challenger
# Wifi White). A trailing lone "s" after one of these ("GamingPro-S") is
# treated as the same line as the bare word — evidence from the real data
# shows the same posting alternates between the two for one product, and the
# risk of it ever meaning a genuinely different SKU is low next to the
# fragmentation it currently causes.
_VARIANT_KEEP_TOKENS = frozenset(
    "gamingpro inspire shadow challenger tuf ayw pro gaming wifi white branco plus "
    "twin dual triple vision eagle phantom windforce strix ventus gamerock suprim "
    "trinity nitro pulse steel legend aorus prime infinity".split()
)


def _has_digit(token: str) -> bool:
    return any(char.isdigit() for char in token)


def _model_fingerprint(
    line: str, *, keep_capacity: bool = False
) -> tuple[str | None, list[str], list[str]]:
    """Split one cleaned product line into (brand, model-code tokens, variant tokens).

    The line is tokenised (`normalize_text`, which folds accents and case —
    stores write "Núcleos"/"NUCLEOS"/"nucleos" interchangeably) before specs
    are stripped, so accent and punctuation quirks in the source never
    matter.

    A trailing lone letter ("-B", "-S", "-P"...) is only ever dropped when it
    is glued to a line/variant word ("GamingPro-S"): real data shows the same
    posting alternates between "GamingPro" and "GamingPro-S" for one product,
    so keeping it would fragment rather than identify. Glued to a model-code
    token instead ("B840M-B", "B650M-A") it is kept as part of that code:
    B650M-A and B650M-P are different, real, differently-priced boards —
    dropping the suffix there would merge two different products, which
    CLAUDE.md rules out (no fuzzy matching, never mix model codes).
    """
    text = _LIAN_LI_RE.sub("lianli", line)
    text = _SERIES_RE.sub(
        lambda match: " ".join(part for part in match.groups() if part), text
    )
    tokens = _strip_spec_tokens(normalize_text(text).split(), keep_capacity=keep_capacity)

    brand: str | None = None
    model_tokens: list[str] = []
    variant_tokens: list[str] = []
    last_kind: str | None = None  # "model" or "variant" of the last kept token
    for token in tokens:
        if _MULTIPLIER_RE.match(token):
            continue
        if len(token) == 1 and token.isalpha():
            if last_kind == "model":
                model_tokens.append(token)
            elif last_kind != "variant":
                # No model/variant token seen yet on this line (or the last
                # one was a brand): too little context to know which side
                # this suffix belongs to, so it is kept rather than risk
                # silently discarding something that distinguishes two
                # products.
                variant_tokens.append(token)
                last_kind = "variant"
            continue
        if any(token in drop_set for drop_set in _DROP_TOKEN_SETS):
            continue
        if brand is None and token in _BRAND_TOKENS:
            brand = token
            continue
        if token in _SERIES_PREFIX_TOKENS or token in _SERIES_SUFFIX_TOKENS or _has_digit(token):
            model_tokens.append(token)
            last_kind = "model"
            continue
        if token in _VARIANT_KEEP_TOKENS:
            variant_tokens.append(token)
            last_kind = "variant"
            continue
        # Unrecognised word: kept. Erring toward fragmentation (an extra key
        # for an unknown word) is safer than silently discarding something
        # that turns out to distinguish two real products.
        variant_tokens.append(token)
        last_kind = "variant"
    return brand, model_tokens, variant_tokens


def _fingerprint(line: str) -> tuple[str | None, list[str], list[str]]:
    """`_model_fingerprint`, with the capacity-recovery retry applied."""
    brand, model_tokens, variant_tokens = _model_fingerprint(line)
    if brand is not None and not model_tokens:
        recovered = _model_fingerprint(line, keep_capacity=True)
        if recovered[1]:
            return recovered
    return brand, model_tokens, variant_tokens


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


def _choose_product_line(cleaned_lines: list[str]) -> str | None:
    """The line that best represents the product's model fingerprint.

    Prefers the first line whose fingerprint has a brand or a variant word,
    or that simply has enough words to be a real description rather than a
    short category tag ("RTX 5070" on its own line, ahead of the actual
    "Placa de vídeo ... Palit RTX5070 12GB Infinity 3 ..." line). Falls back
    to the first line with *any* model-code token when nothing richer shows
    up, so a message that truly is just "RTX 5070" still gets a key.
    """
    fallback: str | None = None
    for line in cleaned_lines:
        brand, model_tokens, variant_tokens = _fingerprint(line)
        if not model_tokens:
            continue
        if fallback is None:
            fallback = line
        if brand is not None or variant_tokens or len(line.split()) >= 4:
            return line
    return fallback


def product_key(message_text: str) -> str | None:
    """Stable, URL-safe product identity (`palit-rtx-5070-ti-gamingpro`) or `None`.

    A "model fingerprint" — brand (small explicit allowlist) + model-code
    tokens + line/variant words, in that order — picked from the first
    product line that actually carries a model code. Capacity, frequency,
    bus/socket, port and count specs never enter it, because they vary post
    to post for the same product; when no model code is found anywhere the
    old, safer behaviour applies (full normalised, truncated title).

    Deterministic: same input, same key, forever — changing this function
    changes the identity of existing rows, so it needs a new backfill
    migration whenever it changes.
    """
    title = product_title(message_text)
    if title is None:
        return None

    cleaned_lines = [
        cleaned
        for line in product_text(message_text).splitlines()
        if (cleaned := _clean_line(line)) is not None
    ]
    chosen_line = _choose_product_line(cleaned_lines)

    if chosen_line is not None:
        brand, model_tokens, variant_tokens = _fingerprint(chosen_line)
        ordered = ([brand] if brand else []) + model_tokens + variant_tokens
        # A word repeated in the source (a call line and the product line
        # both naming the model, "PRO" appearing twice) would otherwise show
        # up twice in the key. Dedup keeps the first occurrence so the
        # canonical brand/model/variant order is unaffected.
        tokens = _trim_edges(list(dict.fromkeys(ordered)))
    else:
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
