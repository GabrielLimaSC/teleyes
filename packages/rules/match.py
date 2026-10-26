import re
from dataclasses import dataclass, field

from packages.rules.normalize import normalize_text

# S17-06: the AND separator is a plus sign with whitespace on both sides, so
# literal terms such as "5g+" or "a+" keep matching as contiguous text.
_AND_SEPARATOR_RE = re.compile(r"\s+\+(?=\s)")

TERM_PART_EMPTY_MESSAGE = (
    'Termo com "+" inválido: há uma parte vazia. '
    'Use o formato "memoria ram + 16gb", com texto dos dois lados do "+".'
)


def split_term_parts(term: str) -> list[str]:
    """Split a term on ` + ` into its raw (un-normalized) parts.

    Splitting must happen BEFORE `normalize_text`, which turns punctuation
    (including `+`) into spaces. A term without the separator yields itself.
    """
    # Padding lets a dangling "+ foo" / "foo +" at the edges count as a separator.
    return [part.strip() for part in _AND_SEPARATOR_RE.split(f" {term.strip()} ")]


def term_error(term: str) -> str | None:
    """pt-BR validation error for a term, or None when it is well formed."""
    parts = split_term_parts(term)
    if len(parts) > 1 and any(not normalize_text(part) for part in parts):
        return TERM_PART_EMPTY_MESSAGE
    return None


def terms_error(raw: str | None) -> str | None:
    """First `term_error` among the comma-separated terms of `raw`."""
    if not raw:
        return None
    for term in raw.split(","):
        if term.strip() and (error := term_error(term)):
            return error
    return None


def term_matches(term: str, normalized_message: str) -> bool:
    """True when `term` is present in an already-normalized message.

    A plain term is one contiguous run; a term with ` + ` needs every part
    present, in any order.
    """
    parts = [normalize_text(part) for part in split_term_parts(term)]
    parts = [part for part in parts if part]
    if not parts:
        return normalize_text(term) in normalized_message
    return all(part in normalized_message for part in parts)


@dataclass
class MatchRule:
    """A rule matches when any include term is present and no exclude term is.

    `include_terms` with more than one entry represent alternatives (OR): the
    message matches if at least one of them is found. `exclude_terms` are a
    blocklist — any hit vetoes the match regardless of the include terms.
    A term containing ` + ` is an AND of its parts (any order); see
    `term_matches`.
    """

    include_terms: list[str]
    exclude_terms: list[str] = field(default_factory=list)

    def blocked_by(self, message_text: str) -> bool:
        normalized_message = normalize_text(message_text)
        return any(term_matches(term, normalized_message) for term in self.exclude_terms)

    def first_include_hit(self, message_text: str) -> str | None:
        normalized_message = normalize_text(message_text)
        return next(
            (term for term in self.include_terms if term_matches(term, normalized_message)),
            None,
        )

    def matches(self, message_text: str) -> bool:
        if self.blocked_by(message_text):
            return False
        return self.first_include_hit(message_text) is not None
