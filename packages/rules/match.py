from dataclasses import dataclass, field

from packages.rules.normalize import normalize_text


@dataclass
class MatchRule:
    """A rule matches when any include term is present and no exclude term is.

    `include_terms` with more than one entry represent alternatives (OR): the
    message matches if at least one of them is found. `exclude_terms` are a
    blocklist — any hit vetoes the match regardless of the include terms.
    """

    include_terms: list[str]
    exclude_terms: list[str] = field(default_factory=list)

    def matches(self, message_text: str) -> bool:
        normalized_message = normalize_text(message_text)

        if any(normalize_text(term) in normalized_message for term in self.exclude_terms):
            return False

        return any(normalize_text(term) in normalized_message for term in self.include_terms)
