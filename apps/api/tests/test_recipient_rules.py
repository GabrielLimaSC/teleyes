"""S21-06 (F8): who receives a match. This decides who gets an alert, so it is
tested at every level: the pure rule (truth table), the real pipeline, the
digest, the repositories, the HTTP API and the migration.
"""

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from tests.conftest import AlembicRunner
from tests.test_configuration_api import client, login  # noqa: F401  (client is a fixture)

from app.digest import run_digest_once
from app.digest_settings import save_digest_settings
from app.main import app, get_db
from app.pipeline import (
    DELIVERY_KIND_DIGEST,
    DELIVERY_KIND_IMMEDIATE,
    IncomingMessage,
    process_message,
)
from app.recipient_rules import RecipientPrefs, recipients_for_match
from models import Delivery, Match, Recipient, RecipientRule, Rule, Snooze, Source
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache
from repositories import recipient_repo, rule_repo
from repositories.errors import InvalidSettingsError

NOW = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)
COMMON_TEXT = "RTX 5070 por R$ 2.000 na Amazon"
TARGET_TEXT = "RTX 5070 por R$ 1.500 na Amazon"  # rule target is R$ 1.800


# ---------------------------------------------------------------- pure rule


def _prefs(
    recipient_id: int,
    *,
    mode: str = "all",
    target: bool = True,
    common: bool = True,
    active: bool = True,
    allowlisted: bool = True,
) -> RecipientPrefs:
    return RecipientPrefs(recipient_id, active, allowlisted, mode, target, common)


@pytest.mark.parametrize(
    ("prefs", "has_rule", "is_target", "expected"),
    [
        # "all" ignores the selection table; the type switch still applies.
        (_prefs(1), False, False, True),
        (_prefs(1), False, True, True),
        (_prefs(1, target=False), False, True, False),
        (_prefs(1, target=False), False, False, True),
        (_prefs(1, common=False), False, False, False),
        (_prefs(1, common=False), False, True, True),
        # "selected" needs the rule.
        (_prefs(1, mode="selected"), True, False, True),
        (_prefs(1, mode="selected"), True, True, True),
        (_prefs(1, mode="selected"), False, False, False),
        (_prefs(1, mode="selected"), False, True, False),
        (_prefs(1, mode="selected", target=False), True, True, False),
        (_prefs(1, mode="selected", target=False), True, False, True),
        (_prefs(1, mode="selected", common=False), True, False, False),
        (_prefs(1, mode="selected", common=False), True, True, True),
        # Paused / not allowlisted never receive, whatever the rest says.
        (_prefs(1, active=False), True, True, False),
        (_prefs(1, active=False), True, False, False),
        (_prefs(1, allowlisted=False), True, True, False),
        (_prefs(1, mode="selected", active=False), True, True, False),
    ],
)
def test_delivery_truth_table(
    prefs: RecipientPrefs, has_rule: bool, is_target: bool, expected: bool
) -> None:
    selection = {1: {7}} if has_rule else {}
    chosen = recipients_for_match(
        [prefs], rule_id=7, is_target_hit=is_target, selected_rule_ids=selection
    )
    assert (chosen == [prefs]) is expected


def test_selection_of_another_rule_does_not_count() -> None:
    prefs = _prefs(1, mode="selected")
    assert recipients_for_match(
        [prefs], rule_id=7, is_target_hit=False, selected_rule_ids={1: {8}}
    ) == []


# ----------------------------------------------------------------- pipeline


def _seed(session: Session) -> tuple[Source, Rule]:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="RTX 5070", include_terms="rtx 5070", target_price_cents=180_000)
    session.add_all([source, rule])
    session.flush()
    return source, rule


def _recipient(session: Session, chat_id: str, **fields: object) -> Recipient:
    recipient = Recipient(name=f"R{chat_id}", telegram_chat_id=chat_id, allowlisted=True, **fields)
    session.add(recipient)
    session.flush()
    return recipient


def _select_rules(session: Session, recipient: Recipient, *rules: Rule) -> None:
    for rule in rules:
        session.add(RecipientRule(recipient_id=recipient.id, rule_id=rule.id))
    session.flush()


def _notifier(client_: FakeBotClient, *chat_ids: str) -> BotNotifier:
    return BotNotifier(bot_token="token", client=client_, allowlisted_chat_ids=set(chat_ids))


def _message(source: Source, text: str, message_id: int = 1) -> IncomingMessage:
    return IncomingMessage(
        source_id=source.id, message_id=message_id, text=text, link=None, received_at=NOW
    )


def _sent_chats(client_: FakeBotClient) -> list[str]:
    return sorted(chat for chat, _ in client_.sent)


async def test_pipeline_all_and_selected_with_and_without_the_rule(session: Session) -> None:
    source, rule = _seed(session)
    other = Rule(name="Outra", include_terms="outra")
    session.add(other)
    everyone = _recipient(session, "1")
    picked = _recipient(session, "2", rules_mode="selected")
    _select_rules(session, picked, rule)
    not_picked = _recipient(session, "3", rules_mode="selected")
    _select_rules(session, not_picked, other)
    fake = FakeBotClient()

    result = await process_message(
        session,
        _message(source, COMMON_TEXT),
        rule,
        [everyone, picked, not_picked],
        _notifier(fake, "1", "2", "3"),
        DedupeCache(),
    )

    assert result.deliveries_sent == 2
    assert _sent_chats(fake) == ["1", "2"]
    assert result.match is not None
    rows = session.scalars(select(Delivery).where(Delivery.match_id == result.match.id)).all()
    assert sorted(row.recipient_id for row in rows) == sorted([everyone.id, picked.id])


async def test_pipeline_target_goes_only_to_notify_target(session: Session) -> None:
    source, rule = _seed(session)
    wants = _recipient(session, "1")
    only_common = _recipient(session, "2", notify_target=False)
    only_target = _recipient(session, "3", notify_common=False)
    fake = FakeBotClient()

    result = await process_message(
        session,
        _message(source, TARGET_TEXT),
        rule,
        [wants, only_common, only_target],
        _notifier(fake, "1", "2", "3"),
        DedupeCache(),
    )

    assert result.target_hit is True
    assert _sent_chats(fake) == ["1", "3"]


async def test_pipeline_common_goes_only_to_notify_common(session: Session) -> None:
    source, rule = _seed(session)
    wants = _recipient(session, "1")
    only_common = _recipient(session, "2", notify_target=False)
    only_target = _recipient(session, "3", notify_common=False)
    fake = FakeBotClient()

    await process_message(
        session,
        _message(source, COMMON_TEXT),
        rule,
        [wants, only_common, only_target],
        _notifier(fake, "1", "2", "3"),
        DedupeCache(),
    )

    assert _sent_chats(fake) == ["1", "2"]


async def test_pipeline_paused_recipient_loaded_earlier_gets_nothing(session: Session) -> None:
    """The listener loads recipients once; pausing in the panel must stop the
    very next match even before "Aplicar regras" reloads that list."""
    source, rule = _seed(session)
    paused = _recipient(session, "1")
    active = _recipient(session, "2")
    paused.active = False
    session.flush()
    fake = FakeBotClient()

    await process_message(
        session,
        _message(source, COMMON_TEXT),
        rule,
        [paused, active],
        _notifier(fake, "1", "2"),
        DedupeCache(),
    )

    assert _sent_chats(fake) == ["2"]


async def test_pipeline_snoozed_rule_silences_common_but_not_target(session: Session) -> None:
    source, rule = _seed(session)
    selected = _recipient(session, "1", rules_mode="selected")
    _select_rules(session, selected, rule)
    session.add(Snooze(scope="rule", rule_id=rule.id, until=NOW + timedelta(hours=1)))
    session.flush()
    fake = FakeBotClient()
    notifier = _notifier(fake, "1")

    common = await process_message(
        session, _message(source, COMMON_TEXT, 1), rule, [selected], notifier, DedupeCache()
    )
    target = await process_message(
        session, _message(source, TARGET_TEXT, 2), rule, [selected], notifier, DedupeCache()
    )

    assert common.reason == "snoozed"
    assert target.deliveries_sent == 1
    assert len(fake.sent) == 1


async def test_pipeline_digest_queue_only_for_notify_common(session: Session) -> None:
    source, rule = _seed(session)
    save_digest_settings(
        session, enabled=True, send_at_local="09:00", top_n=5, mute_individual=True
    )
    wants = _recipient(session, "1")
    no_common = _recipient(session, "2", notify_common=False)
    fake = FakeBotClient()

    result = await process_message(
        session,
        _message(source, COMMON_TEXT),
        rule,
        [wants, no_common],
        _notifier(fake, "1", "2"),
        DedupeCache(),
    )

    assert fake.sent == []
    assert result.match is not None
    rows = session.scalars(select(Delivery).where(Delivery.match_id == result.match.id)).all()
    assert [(row.recipient_id, row.kind, row.status) for row in rows] == [
        (wants.id, DELIVERY_KIND_DIGEST, "pending")
    ]


async def test_pipeline_global_policy_stays_the_channel_without_digest(session: Session) -> None:
    """No digest muting: a common match is an immediate ping, as before F8."""
    source, rule = _seed(session)
    wants = _recipient(session, "1")
    fake = FakeBotClient()

    result = await process_message(
        session, _message(source, COMMON_TEXT), rule, [wants], _notifier(fake, "1"), DedupeCache()
    )

    assert result.match is not None
    row = session.scalars(select(Delivery).where(Delivery.match_id == result.match.id)).one()
    assert (row.kind, row.status) == (DELIVERY_KIND_IMMEDIATE, "sent")


async def test_restart_does_not_duplicate_the_alert(session: Session) -> None:
    """Same Telegram message reprocessed with a cold cache and a new notifier
    (what a restart looks like) must not alert the selected person again."""
    source, rule = _seed(session)
    selected = _recipient(session, "1", rules_mode="selected")
    _select_rules(session, selected, rule)
    session.commit()
    fake = FakeBotClient()

    first = await process_message(
        session,
        _message(source, COMMON_TEXT),
        rule,
        [selected],
        _notifier(fake, "1"),
        DedupeCache(),
    )
    session.commit()
    second = await process_message(
        session,
        _message(source, COMMON_TEXT),
        rule,
        [selected],
        _notifier(fake, "1"),
        DedupeCache(),
    )
    session.commit()

    assert first.deliveries_sent == 1
    assert second.reason == "duplicate"
    assert len(fake.sent) == 1
    assert len(session.scalars(select(Delivery)).all()) == 1


# ------------------------------------------------------------------- digest


def _queue(session: Session, source: Source, rule: Rule, recipient: Recipient) -> None:
    match = Match(
        source_id=source.id,
        rule_id=rule.id,
        telegram_message_id=900 + recipient.id,
        message_text=COMMON_TEXT,
        price_cents=200_000,
        matched_at=NOW,
    )
    session.add(match)
    session.flush()
    session.add(
        Delivery(
            match_id=match.id,
            recipient_id=recipient.id,
            kind=DELIVERY_KIND_DIGEST,
            status="pending",
        )
    )
    session.flush()


async def test_digest_only_goes_to_recipients_with_notify_common(session: Session) -> None:
    from zoneinfo import ZoneInfo

    source, rule = _seed(session)
    wants = _recipient(session, "1")
    switched_off = _recipient(session, "2", notify_common=False)
    _queue(session, source, rule, wants)
    _queue(session, source, rule, switched_off)
    fake = FakeBotClient()

    outcome = await run_digest_once(
        session, _notifier(fake, "1", "2"), now=NOW, tz=ZoneInfo("UTC"), top_n=5
    )

    assert outcome.sent is True
    assert [chat for chat, _ in fake.sent] == ["1"]
    leftover = session.scalars(
        select(Delivery).where(Delivery.recipient_id == switched_off.id)
    ).one()
    assert leftover.status == "pending"  # kept, not lost, if they turn it back on


# ------------------------------------------------------------- repositories


def test_new_rule_reaches_all_but_not_selected(session: Session) -> None:
    everyone = _recipient(session, "1")
    selected = _recipient(session, "2", rules_mode="selected")
    first = rule_repo.create_rule(session, name="A", include_terms="a")
    _select_rules(session, selected, first)
    new = rule_repo.create_rule(session, name="B", include_terms="b")
    selection = {selected.id: {first.id}}

    for_new = recipients_for_match(
        [everyone, selected], rule_id=new.id, is_target_hit=False, selected_rule_ids=selection
    )

    assert for_new == [everyone]


def test_deleting_a_rule_removes_it_from_selections(session: Session) -> None:
    selected = _recipient(session, "1", rules_mode="selected")
    keep = rule_repo.create_rule(session, name="A", include_terms="a")
    gone = rule_repo.create_rule(session, name="B", include_terms="b")
    _select_rules(session, selected, keep, gone)

    rule_repo.delete_rule(session, gone.id)

    assert recipient_repo.get_rule_ids(session, selected.id) == [keep.id]
    rule_repo.delete_rule(session, keep.id)
    # Zero rules in "selected" is a valid stored state: it simply receives nothing.
    assert recipient_repo.get_rule_ids(session, selected.id) == []
    assert recipients_for_match(
        [selected], rule_id=keep.id, is_target_hit=True, selected_rule_ids={}
    ) == []


def test_deleting_a_recipient_removes_its_selection(session: Session) -> None:
    selected = _recipient(session, "1", rules_mode="selected")
    rule = rule_repo.create_rule(session, name="A", include_terms="a")
    _select_rules(session, selected, rule)

    recipient_repo.delete_recipient(session, selected.id)

    assert session.scalars(select(RecipientRule)).all() == []


def test_repo_rejects_selected_without_rules_or_without_types(session: Session) -> None:
    rule = rule_repo.create_rule(session, name="A", include_terms="a")
    with pytest.raises(InvalidSettingsError):
        recipient_repo.create_recipient(
            session, name="X", telegram_chat_id="1", rules_mode="selected", rule_ids=[]
        )
    with pytest.raises(InvalidSettingsError):
        recipient_repo.create_recipient(
            session,
            name="X",
            telegram_chat_id="1",
            rules_mode="selected",
            rule_ids=[rule.id],
            notify_target=False,
            notify_common=False,
        )
    with pytest.raises(InvalidSettingsError):
        recipient_repo.create_recipient(
            session, name="X", telegram_chat_id="1", rules_mode="selected", rule_ids=[999]
        )


def test_unrelated_patch_is_not_blocked_by_an_emptied_selection(session: Session) -> None:
    selected = _recipient(session, "1", rules_mode="selected")

    recipient_repo.update_recipient(session, selected.id, name="Novo nome")

    assert selected.name == "Novo nome"


# --------------------------------------------------------------------- HTTP


def _db() -> Session:
    return next(app.dependency_overrides[get_db]())


def _make_rule(client_: TestClient, headers: dict[str, str], name: str, **fields: object) -> int:
    response = client_.post(
        "/rules", json={"name": name, "include_terms": name.lower(), **fields}, headers=headers
    )
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def test_api_defaults_roundtrip_and_validation(client: TestClient) -> None:  # noqa: F811
    headers = {"x-csrf-token": login(client)}
    rule_a = _make_rule(client, headers, "Alpha")
    rule_b = _make_rule(client, headers, "Beta")

    created = client.post(
        "/recipients", json={"name": "Ana", "telegram_chat_id": "1"}, headers=headers
    ).json()
    assert created["rules_mode"] == "all"
    assert created["rule_ids"] == []
    assert created["notify_target"] is True and created["notify_common"] is True

    patched = client.patch(
        f"/recipients/{created['id']}",
        json={
            "rules_mode": "selected",
            "rule_ids": [rule_a, rule_b],
            "notify_target": True,
            "notify_common": False,
        },
        headers=headers,
    )
    assert patched.status_code == 200
    assert patched.json()["rule_ids"] == [rule_a, rule_b]
    assert patched.json()["notify_common"] is False
    assert client.get("/recipients").json()[0]["rule_ids"] == [rule_a, rule_b]

    for bad in (
        {"rules_mode": "selected", "rule_ids": []},
        {
            "rules_mode": "selected",
            "rule_ids": [rule_a],
            "notify_target": False,
            "notify_common": False,
        },
        {"rules_mode": "selected", "rule_ids": [9999]},
        {"rules_mode": "nope"},
    ):
        response = client.patch(f"/recipients/{created['id']}", json=bad, headers=headers)
        assert response.status_code == 422, bad
        assert isinstance(response.json()["detail"], str)
    # A rejected PATCH leaves the stored state untouched.
    assert client.get("/recipients").json()[0]["rule_ids"] == [rule_a, rule_b]

    invalid_create = client.post(
        "/recipients",
        json={"name": "Bia", "telegram_chat_id": "2", "rules_mode": "selected"},
        headers=headers,
    )
    assert invalid_create.status_code == 422
    assert "Escolha pelo menos uma regra" in invalid_create.json()["detail"]


def test_api_changes_require_csrf(client: TestClient) -> None:  # noqa: F811
    login(client)
    response = client.post("/recipients", json={"name": "Ana", "telegram_chat_id": "1"})
    assert response.status_code in (401, 403)


def test_api_deleting_a_rule_shrinks_the_selection(client: TestClient) -> None:  # noqa: F811
    headers = {"x-csrf-token": login(client)}
    rule_a = _make_rule(client, headers, "Alpha")
    rule_b = _make_rule(client, headers, "Beta")
    recipient = client.post(
        "/recipients",
        json={
            "name": "Ana",
            "telegram_chat_id": "1",
            "allowlisted": True,
            "rules_mode": "selected",
            "rule_ids": [rule_a, rule_b],
        },
        headers=headers,
    ).json()

    assert client.delete(f"/rules/{rule_b}", headers=headers).status_code == 204

    assert client.get("/recipients").json()[0]["rule_ids"] == [rule_a]
    assert recipient["id"] == client.get("/recipients").json()[0]["id"]


def test_api_rules_list_exposes_who_receives_each_rule(client: TestClient) -> None:  # noqa: F811
    headers = {"x-csrf-token": login(client)}
    rule_a = _make_rule(client, headers, "Alpha")
    rule_b = _make_rule(client, headers, "Beta")

    def add(chat: str, **fields: object) -> int:
        body = {"name": f"P{chat}", "telegram_chat_id": chat, "allowlisted": True, **fields}
        return int(client.post("/recipients", json=body, headers=headers).json()["id"])

    everyone = add("1")
    picked = add("2", rules_mode="selected", rule_ids=[rule_a], notify_common=False)
    unallowed = client.post(
        "/recipients", json={"name": "Z", "telegram_chat_id": "3"}, headers=headers
    ).json()["id"]
    paused = add("4")
    client.post(f"/recipients/{paused}/pause", headers=headers)

    by_rule = {rule["id"]: rule["recipient_ids"] for rule in client.get("/rules").json()}

    assert by_rule[rule_a] == [everyone, picked]
    assert by_rule[rule_b] == [everyone]
    assert unallowed not in by_rule[rule_a] and paused not in by_rule[rule_a]


def test_api_preview_counts_last_7_days_filtered_by_type(client: TestClient) -> None:  # noqa: F811
    headers = {"x-csrf-token": login(client)}
    rule_a = _make_rule(client, headers, "Alpha", target_price_cents=100_000)
    rule_b = _make_rule(client, headers, "Beta")
    db = _db()
    source = Source(name="G", telegram_chat_id="-1")
    db.add(source)
    db.flush()
    now = datetime.now(UTC)

    def match(rule_id: int, price: int, days_ago: float, n: int) -> None:
        db.add(
            Match(
                source_id=source.id,
                rule_id=rule_id,
                telegram_message_id=n,
                message_text="x",
                price_cents=price,
                matched_at=now - timedelta(days=days_ago),
            )
        )

    match(rule_a, 90_000, 1, 1)  # target hit
    match(rule_a, 150_000, 2, 2)  # common
    match(rule_a, 150_000, 3, 3)  # common
    match(rule_a, 150_000, 9, 4)  # outside the window
    match(rule_b, 50_000, 1, 5)  # common (rule has no target)
    db.commit()

    both = client.get("/recipients/preview").json()
    assert both["alerts_per_week"] == 4
    assert {item["rule_id"]: item["per_week"] for item in both["per_rule"]} == {
        rule_a: 3,
        rule_b: 1,
    }

    only_target = client.get(
        f"/recipients/preview?rules_mode=selected&rule_ids={rule_a}&notify_common=false"
    ).json()
    assert only_target["alerts_per_week"] == 1
    assert only_target["per_rule"] == [{"rule_id": rule_a, "per_week": 1}]

    only_common = client.get(
        f"/recipients/preview?rules_mode=selected&rule_ids={rule_a}&rule_ids={rule_b}"
        "&notify_target=false"
    ).json()
    assert only_common["alerts_per_week"] == 3

    invalid = client.get("/recipients/preview?rules_mode=selected")
    assert invalid.status_code == 422


# ---------------------------------------------------------------- migration


def test_f8_migration_keeps_delivery_unchanged_and_downgrades(
    db_path: Path, alembic_runner: AlembicRunner
) -> None:
    url = f"sqlite:///{db_path}"
    previous_head = "a3f9d2c8b714"
    assert alembic_runner("upgrade", previous_head, database_url=url).returncode == 0
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "INSERT INTO recipient (id, name, telegram_chat_id, allowlisted, active, created_at) "
            "VALUES (1, 'Gabriel', '999', 1, 1, '2026-11-01 12:00:00')"
        )
        connection.execute(
            "INSERT INTO digest_settings (id, enabled, send_at_local, top_n, mute_individual, "
            "updated_at) VALUES (1, 1, '09:00', 5, 1, '2026-11-01 12:00:00')"
        )

    upgrade = alembic_runner("upgrade", "head", database_url=url)
    assert upgrade.returncode == 0, upgrade.stderr

    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            "SELECT rules_mode, notify_target, notify_common FROM recipient WHERE id = 1"
        ).fetchone()
        table = connection.execute(
            "SELECT name FROM sqlite_master WHERE name = 'recipient_rule'"
        ).fetchone()
        mute = connection.execute("SELECT mute_individual FROM digest_settings").fetchone()
    assert row == ("all", 1, 1)  # everyone keeps receiving everything, as before
    assert table is not None
    assert mute == (1,)  # the global channel policy is untouched

    downgrade = alembic_runner("downgrade", previous_head, database_url=url)
    assert downgrade.returncode == 0, downgrade.stderr
    with sqlite3.connect(db_path) as connection:
        columns = {r[1] for r in connection.execute("PRAGMA table_info('recipient')")}
        gone = connection.execute(
            "SELECT name FROM sqlite_master WHERE name = 'recipient_rule'"
        ).fetchone()
        kept = connection.execute("SELECT name FROM recipient WHERE id = 1").fetchone()
    assert not columns & {"rules_mode", "notify_target", "notify_common"}
    assert gone is None
    assert kept == ("Gabriel",)

    assert alembic_runner("upgrade", "head", database_url=url).returncode == 0
