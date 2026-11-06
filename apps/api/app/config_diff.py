"""S25-F4: a light "what changed since the last apply" for the Regras banner.

The listener runs on the configuration it loaded at the last "Aplicar regras".
When it applies, it stores a small JSON snapshot of that configuration (names
plus only the fields that change what it does). The panel diffs the live
database against the snapshot to say "preço-alvo de Fone bluetooth, nova regra
SSD NVMe" instead of a bare "há mudanças".

Only *active* items are in the snapshot, exactly like the fingerprint: a rename
changes nothing the listener does, so it is never a change. Nothing here stores
message text. A snapshot too old or malformed to read yields no changes, and the
panel then shows the generic notice (the fingerprint still decides whether
something is unapplied).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.utc import ensure_utc
from models import Recipient, Rule, Source

Entity = Literal["rule", "source", "recipient"]
Action = Literal["created", "activated", "edited", "paused", "deleted"]

# Item = {"name": str, "f": {field: value}}; the snapshot maps entity -> id -> item.
_ENTITY_KEYS: tuple[tuple[Entity, str], ...] = (
    ("rule", "rules"),
    ("source", "sources"),
    ("recipient", "recipients"),
)


@dataclass(frozen=True)
class ConfigChange:
    entity: Entity
    action: Action
    name: str
    # Only for `edited`: which fields differ ("terms", "max_price", "target_price", "chat").
    fields: tuple[str, ...] = ()


def _chat_fingerprint(chat_id: str) -> str:
    # The chat id itself is not needed to say "the address changed".
    return hashlib.sha256(chat_id.encode()).hexdigest()[:12]


def _rule_item(rule: Rule) -> dict[str, Any]:
    return {
        "name": rule.name,
        "f": {
            "terms": [rule.include_terms, rule.exclude_terms or ""],
            "max_price": rule.max_price_cents,
            "target_price": rule.target_price_cents,
        },
    }


def _chat_item(item: Source | Recipient) -> dict[str, Any]:
    return {"name": item.name, "f": {"chat": _chat_fingerprint(item.telegram_chat_id)}}


def build_snapshot(
    sources: Sequence[Source], rules: Sequence[Rule], recipients: Sequence[Recipient]
) -> str:
    payload = {
        "rules": {str(r.id): _rule_item(r) for r in rules},
        "sources": {str(s.id): _chat_item(s) for s in sources},
        "recipients": {str(r.id): _chat_item(r) for r in recipients},
    }
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def _parse(snapshot: str | None) -> dict[str, dict[str, Any]] | None:
    if snapshot is None:
        return None
    try:
        data = json.loads(snapshot)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    return {key: data.get(key) or {} for _, key in _ENTITY_KEYS}


def _is_new(created_at: datetime | None, applied_at: datetime | None) -> bool:
    """Created after the last apply means brand new; otherwise it came back (resumed)."""
    if applied_at is None or created_at is None:
        return True
    return ensure_utc(created_at) > ensure_utc(applied_at)


def diff_config(
    session: Session,
    snapshot: str | None,
    *,
    applied_at: datetime | None,
    live: tuple[Sequence[Source], Sequence[Rule], Sequence[Recipient]],
) -> list[ConfigChange]:
    """Changes of the live (active) configuration against the applied snapshot."""
    previous = _parse(snapshot)
    if previous is None:
        return []
    live_sources, live_rules, live_recipients = live
    current = {
        "rules": {str(r.id): _rule_item(r) for r in live_rules},
        "sources": {str(s.id): _chat_item(s) for s in live_sources},
        "recipients": {str(r.id): _chat_item(r) for r in live_recipients},
    }
    models: dict[str, Any] = {"rules": Rule, "sources": Source, "recipients": Recipient}

    changes: list[ConfigChange] = []
    for entity, key in _ENTITY_KEYS:
        before: Mapping[str, Any] = previous[key]
        after: Mapping[str, Any] = current[key]
        existing = {
            str(row_id): created_at
            for row_id, created_at in session.execute(
                select(models[key].id, models[key].created_at)
            ).all()
        }
        for item_id, item in after.items():
            old = before.get(item_id)
            if old is None:
                action: Action = (
                    "created" if _is_new(existing.get(item_id), applied_at) else "activated"
                )
                changes.append(ConfigChange(entity, action, item["name"]))
            elif old.get("f") != item["f"]:
                fields = tuple(k for k, v in item["f"].items() if old.get("f", {}).get(k) != v)
                changes.append(ConfigChange(entity, "edited", item["name"], fields))
        for item_id, old in before.items():
            if item_id in after:
                continue
            action = "paused" if item_id in existing else "deleted"
            changes.append(ConfigChange(entity, action, str(old.get("name", ""))))
    return changes
