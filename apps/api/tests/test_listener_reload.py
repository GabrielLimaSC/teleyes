"""S13-06, integration: "Aplicar regras" reloads the running listener in process.

Real parts: `ListenerLifecycle` (with its `apply_config`), `ReloadWorker`, the
`listener_control` mailbox, the real pipeline (`process_message`,
`run_historical_scan`, cursors, identity, dedupe) and a real SQLite database
migrated with Alembic. Fake parts: Telegram (`FakeChats`, a per-chat message
backlog) and the bot API (`FakeBotClient`). What it proves is logic and
idempotence; it says nothing about the real Telegram service or the Telethon
event objects (the script's handler only forwards to `handle_live_message`).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.listener_control import (
    ControlSnapshot,
    config_fingerprint,
    load_active_config,
    read_snapshot,
    record_applied,
    request_reload,
)
from app.listener_lifecycle import ListenerLifecycle, build_listener_sources
from app.listener_reload import ReloadWorker
from models import Delivery, ListenerControl, Match, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache
from packages.telegram.cursor import TelegramMessage, get_cursor, has_cursor

CHAT_A = "-1001"
CHAT_B = "-1002"


class FakeChats:
    """Per-chat message backlog, served newest first / by `min_id` like Telegram."""

    def __init__(self) -> None:
        self.messages: dict[str, list[TelegramMessage]] = {}
        self.fail_recent_for: dict[str, Exception] = {}
        self.block_iter_messages: asyncio.Event | None = None
        self.iter_messages_started = asyncio.Event()

    def post(self, chat_id: str, message_id: int, text: str, *, hours_ago: float = 1.0) -> None:
        date = datetime.now(UTC) - timedelta(hours=hours_ago)
        self.messages.setdefault(chat_id, []).append(
            TelegramMessage(id=message_id, text=text, date=date)
        )

    async def iter_messages(
        self, chat_id: str, *, min_id: int, limit: int
    ) -> AsyncIterator[TelegramMessage]:
        self.iter_messages_started.set()
        if self.block_iter_messages is not None:
            await self.block_iter_messages.wait()
        for message in sorted(self.messages.get(chat_id, []), key=lambda m: m.id):
            if message.id > min_id:
                yield message

    async def iter_recent(self, chat_id: str) -> AsyncIterator[TelegramMessage]:
        if chat_id in self.fail_recent_for:
            raise self.fail_recent_for[chat_id]
        for message in sorted(self.messages.get(chat_id, []), key=lambda m: m.id, reverse=True):
            yield message


class World:
    """What `scripts/run_listener.py` wires, minus Telethon and the process."""

    def __init__(self, session: Session, db_path: Path) -> None:
        self.session = session
        self.factory: sessionmaker[Session] = get_sessionmaker(
            get_engine(f"sqlite:///{db_path}")
        )
        self.chats = FakeChats()
        self.bot = FakeBotClient()
        self.notifier = BotNotifier(bot_token="token", client=self.bot, allowlisted_chat_ids=set())
        self.printed: list[str] = []
        self.handler_registrations = 0
        self.connected = True
        self.lifecycle: ListenerLifecycle | None = None
        self.worker: ReloadWorker | None = None

    # -- configuration, exactly as the panel would leave it in the database --
    def add_source(self, chat_id: str, name: str = "Grupo") -> Source:
        source = Source(name=name, telegram_chat_id=chat_id)
        self.session.add(source)
        self.session.commit()
        return source

    def add_rule(self, include: str, name: str = "Regra", **fields: object) -> Rule:
        rule = Rule(name=name, include_terms=include, **fields)
        self.session.add(rule)
        self.session.commit()
        return rule

    def add_recipient(self, chat_id: str, name: str = "Gabriel") -> Recipient:
        recipient = Recipient(name=name, telegram_chat_id=chat_id, allowlisted=True)
        self.session.add(recipient)
        self.session.commit()
        return recipient

    def pause(self, row: Source | Rule | Recipient) -> None:
        row.active = False
        self.session.commit()

    # -- the listener process --
    async def boot(self) -> None:
        """`main()`: read the config, build the lifecycle, first connection."""
        with self.factory() as session:
            sources, rules, recipients = load_active_config(session)
            record_applied(
                session,
                sources_loaded=len(sources),
                rules_loaded=len(rules),
                recipients_loaded=len(recipients),
                config_hash=config_fingerprint(sources, rules, recipients),
            )
        self.notifier.set_allowlisted_chat_ids({r.telegram_chat_id for r in recipients})
        self.lifecycle = ListenerLifecycle(
            session_factory=self.factory,
            fetcher=self.chats,
            sources=build_listener_sources(sources, rules, recipients),
            notifier=self.notifier,
            dedupe_cache=DedupeCache(),
            register_live_handler=self._register_handler,
            printer=self.printed.append,
        )
        self.worker = ReloadWorker(
            session_factory=self.factory,
            lifecycle=self.lifecycle,
            is_connected=lambda: self.connected,
        )
        await self.lifecycle.on_connected()

    def _register_handler(self) -> None:
        self.handler_registrations += 1

    async def live(self, chat_id: str, message_id: int, text: str) -> None:
        assert self.lifecycle is not None
        self.chats.post(chat_id, message_id, text, hours_ago=0.0)
        await self.lifecycle.handle_live_message(
            int(chat_id), TelegramMessage(id=message_id, text=text, date=datetime.now(UTC))
        )

    async def click_apply(self) -> ControlSnapshot:
        """The panel's POST, then one poll tick of the listener."""
        assert self.worker is not None
        with self.factory() as session:
            request_reload(session)
        await self.worker.poll_once()
        return self.status()

    def status(self) -> ControlSnapshot:
        with self.factory() as session:
            return read_snapshot(session)

    # -- assertions helpers --
    def matches(self) -> list[tuple[str, int | None, int]]:
        """(source chat id, telegram message id, rule id) of every persisted match."""
        self.session.expire_all()
        rows = self.session.execute(
            select(Source.telegram_chat_id, Match.telegram_message_id, Match.rule_id)
            .join(Source, Source.id == Match.source_id)
            .order_by(Match.telegram_message_id, Match.rule_id)
        ).all()
        return [(chat, message, rule) for chat, message, rule in rows]

    def delivery_statuses(self) -> list[str]:
        self.session.expire_all()
        return sorted(self.session.scalars(select(Delivery.status)))

    def alerted_texts(self) -> list[str]:
        return [text for _chat, text in self.bot.sent]

    def alerted_chats(self) -> list[str]:
        return [chat for chat, _text in self.bot.sent]


async def test_a_rule_created_after_boot_matches_history_and_live_without_a_restart(
    db_path: Path, session: Session
) -> None:
    world = World(session, db_path)
    world.add_source(CHAT_A)
    world.add_rule("iphone", name="iPhone")
    world.add_recipient("999")
    world.chats.post(CHAT_A, 1, "PS5 por R$ 3.000", hours_ago=2)
    world.chats.post(CHAT_A, 2, "Monitor 27 por R$ 900", hours_ago=1)
    await world.boot()
    assert world.status().has_unapplied_changes is False

    # The admin creates a rule for what the group already posted.
    new_rule = world.add_rule("ps5", name="PS5")
    assert world.status().has_unapplied_changes is True
    await world.live(CHAT_A, 3, "Promoção PS5 por R$ 2.900")
    assert world.alerted_texts() == []  # the new rule is not live before the request

    status = await world.click_apply()

    assert status.state == "idle" and status.error is None
    assert (status.sources_loaded, status.rules_loaded, status.recipients_loaded) == (1, 2, 1)
    assert status.new_matches == 2  # message 1 and message 3 are in the 7-day window
    assert status.has_unapplied_changes is False
    assert status.reload_applied_at is not None
    # History matches the new rule, and none of it alerted anyone.
    assert world.matches() == [(CHAT_A, 1, new_rule.id), (CHAT_A, 3, new_rule.id)]
    assert world.delivery_statuses() == ["historical", "historical"]
    assert world.alerted_texts() == []
    # Live: the same handler that existed at boot, now with the new rule.
    await world.live(CHAT_A, 4, "PS5 Slim de novo por R$ 2.800")
    assert world.alerted_texts() == ["PS5 Slim de novo por R$ 2.800"]
    assert world.handler_registrations == 1  # the process was never restarted


async def test_a_new_source_and_a_new_recipient_start_listening_after_the_request(
    db_path: Path, session: Session
) -> None:
    world = World(session, db_path)
    world.add_source(CHAT_A)
    rule = world.add_rule("iphone")
    world.add_recipient("999")
    world.chats.post(CHAT_A, 1, "iphone antigo R$ 500", hours_ago=3)
    await world.boot()

    world.add_source(CHAT_B, name="Grupo novo")
    world.add_recipient("888", name="Namorada")
    world.chats.post(CHAT_B, 10, "iphone 15 R$ 4.000 (antes do pedido)", hours_ago=2)
    world.chats.post(CHAT_B, 11, "monitor sem relação", hours_ago=1)

    # Before the request the new group is not listened to at all.
    await world.live(CHAT_B, 12, "iphone 14 R$ 3.000 (ainda não escutado)")
    assert world.alerted_texts() == []

    status = await world.click_apply()

    assert status.state == "idle"
    assert (status.sources_loaded, status.recipients_loaded) == (2, 2)
    with world.factory() as check:
        new_source = check.scalars(select(Source).where(Source.telegram_chat_id == CHAT_B)).one()
        # Cursor at the chat's head: no catch-up will ever alert for what is older.
        assert get_cursor(check, new_source.id) == 12
    assert (CHAT_B, 10, rule.id) in world.matches()
    assert world.alerted_texts() == []  # nothing retroactive
    assert set(world.delivery_statuses()) == {"historical"}

    # Live now reaches BOTH recipients, including the one created after boot.
    await world.live(CHAT_B, 13, "iphone 13 por R$ 2.500 agora")
    assert sorted(world.alerted_chats()) == ["888", "999"]


async def test_booting_empty_stays_alive_and_starts_listening_after_the_request(
    db_path: Path, session: Session
) -> None:
    """The real case of the wipe: nothing registered at boot ("nada pra escutar")."""
    world = World(session, db_path)
    await world.boot()
    assert world.lifecycle is not None
    assert world.lifecycle.started is True
    assert world.lifecycle.sources == []
    assert world.handler_registrations == 1

    await world.live(CHAT_A, 1, "iphone R$ 100")  # dropped: no source is listened to
    assert world.matches() == []

    world.add_source(CHAT_A)
    rule = world.add_rule("iphone")
    world.add_recipient("999")
    world.chats.post(CHAT_A, 1, "iphone R$ 100", hours_ago=5)
    world.chats.post(CHAT_A, 2, "outro assunto", hours_ago=4)

    status = await world.click_apply()

    assert status.state == "idle"
    assert (status.sources_loaded, status.rules_loaded, status.recipients_loaded) == (1, 1, 1)
    assert status.new_matches == 1
    assert world.matches() == [(CHAT_A, 1, rule.id)]
    assert world.alerted_texts() == []
    await world.live(CHAT_A, 3, "iphone 15 R$ 4.500 saiu agora")
    assert world.alerted_texts() == ["iphone 15 R$ 4.500 saiu agora"]
    assert world.handler_registrations == 1  # no second handler, no restart


async def test_a_source_held_out_for_lack_of_rules_gets_its_cursor_at_the_head_later(
    db_path: Path, session: Session
) -> None:
    """Sources with zero rules are not "live": otherwise their cursor would lag
    and a later reconnect catch-up would alert for the whole gap (S6-04)."""
    world = World(session, db_path)
    source = world.add_source(CHAT_A)
    world.add_recipient("999")
    world.chats.post(CHAT_A, 1, "iphone velho", hours_ago=1)
    await world.boot()  # a source and a recipient, but no rule
    assert world.lifecycle is not None and world.lifecycle.sources == []

    world.chats.post(CHAT_A, 2, "iphone chegou sem regra", hours_ago=0.5)
    world.add_rule("iphone")
    await world.click_apply()

    with world.factory() as check:
        assert get_cursor(check, source.id) == 2
    await world.lifecycle.catch_up()  # a later reconnect
    assert world.alerted_texts() == []


async def test_a_reactivated_source_with_a_stale_cursor_never_alerts_retroactively(
    db_path: Path, session: Session
) -> None:
    world = World(session, db_path)
    source = world.add_source(CHAT_A)
    world.add_rule("iphone")
    world.add_recipient("999")
    world.chats.post(CHAT_A, 5, "iphone antigo", hours_ago=30)
    await world.boot()
    with world.factory() as check:
        assert has_cursor(check, source.id)

    world.pause(source)
    await world.click_apply()
    assert world.lifecycle is not None and world.lifecycle.sources == []

    # While it was paused the group posted matching messages inside the 24h
    # window a boot catch-up would have alerted for.
    world.chats.post(CHAT_A, 6, "iphone 15 R$ 4.000", hours_ago=3)
    world.chats.post(CHAT_A, 7, "iphone 14 R$ 3.000", hours_ago=2)
    source.active = True
    world.session.commit()

    status = await world.click_apply()

    assert status.state == "idle"
    assert world.alerted_texts() == []
    with world.factory() as check:
        assert get_cursor(check, source.id) == 7
    await world.lifecycle.catch_up()
    assert world.alerted_texts() == []
    # ...yet the history is visible, marked as such.
    assert {row[1] for row in world.matches()} == {5, 6, 7}


async def test_pausing_a_rule_or_a_source_stops_matching_after_the_request(
    db_path: Path, session: Session
) -> None:
    world = World(session, db_path)
    source_a = world.add_source(CHAT_A)
    world.add_source(CHAT_B)
    rule_iphone = world.add_rule("iphone")
    world.add_rule("ps5")
    world.add_recipient("999")
    await world.boot()

    world.pause(rule_iphone)
    world.pause(source_a)
    assert world.status().has_unapplied_changes is True
    await world.live(CHAT_A, 1, "iphone ainda escutado antes do pedido")
    assert len(world.alerted_texts()) == 1

    await world.click_apply()

    await world.live(CHAT_A, 2, "iphone e ps5 no grupo pausado")
    await world.live(CHAT_B, 3, "iphone no grupo B com regra pausada")
    assert len(world.alerted_texts()) == 1  # nothing new
    await world.live(CHAT_B, 4, "ps5 no grupo B")
    assert world.alerted_texts()[-1] == "ps5 no grupo B"


async def test_a_paused_recipient_no_longer_receives_after_the_request(
    db_path: Path, session: Session
) -> None:
    world = World(session, db_path)
    world.add_source(CHAT_A)
    world.add_rule("iphone")
    world.add_recipient("999")
    other = world.add_recipient("888", name="Namorada")
    await world.boot()
    await world.live(CHAT_A, 1, "iphone um")
    assert sorted(world.alerted_chats()) == ["888", "999"]

    world.pause(other)
    await world.click_apply()
    await world.live(CHAT_A, 2, "iphone dois")

    assert sorted(world.alerted_chats()) == ["888", "999", "999"]


async def test_a_failed_reload_keeps_the_old_configuration_and_can_be_retried(
    db_path: Path, session: Session
) -> None:
    world = World(session, db_path)
    world.add_source(CHAT_A)
    world.add_rule("iphone", name="iPhone")
    world.add_recipient("999")
    await world.boot()
    assert world.lifecycle is not None
    old_sources = world.lifecycle.sources

    world.add_source(CHAT_B, name="Grupo novo")
    world.add_rule("ps5", name="PS5")
    world.add_recipient("888", name="Namorada")
    secret = "R$ 999 texto de mensagem que nunca pode aparecer no erro"
    world.chats.fail_recent_for[CHAT_B] = RuntimeError(secret)

    status = await world.click_apply()

    assert status.state == "failed"
    assert status.error == "RuntimeError"  # the class only, never the message
    assert secret not in (status.error or "")
    assert status.has_unapplied_changes is True  # the old config is still what runs
    assert status.reload_applied_at is not None  # ...from the previous load
    assert world.lifecycle.sources == old_sources
    # Old config unchanged in every way: old rule only, old recipient only, old chat only.
    await world.live(CHAT_A, 1, "ps5 no grupo A")  # the new rule is not live
    await world.live(CHAT_B, 2, "iphone no grupo B")  # the new chat is not listened to
    assert world.alerted_texts() == []
    await world.live(CHAT_A, 3, "iphone no grupo A")
    assert world.alerted_chats() == ["999"]

    # The cause goes away; a new request works.
    del world.chats.fail_recent_for[CHAT_B]
    retried = await world.click_apply()
    assert retried.state == "idle" and retried.error is None
    await world.live(CHAT_B, 4, "iphone no grupo B agora")
    assert sorted(world.alerted_chats()) == ["888", "999", "999"]


async def test_a_history_scan_failure_of_one_source_does_not_undo_the_reload(
    db_path: Path, session: Session
) -> None:
    world = World(session, db_path)
    world.add_source(CHAT_A)
    rule = world.add_rule("iphone")
    world.add_recipient("999")
    await world.boot()
    world.add_source(CHAT_B)
    world.chats.post(CHAT_A, 1, "iphone A", hours_ago=1)
    # Reachable for the cursor head, unreachable for the window scan afterwards.
    world.chats.post(CHAT_B, 1, "iphone B", hours_ago=1)
    original_recent = world.chats.iter_recent
    calls = {"B": 0}

    async def flaky(chat_id: str) -> AsyncIterator[TelegramMessage]:
        if chat_id == CHAT_B:
            calls["B"] += 1
            if calls["B"] > 1:  # 1st call = cursor head, 2nd = the scan
                raise PermissionError("chat inacessível")
        async for message in original_recent(chat_id):
            yield message

    world.chats.iter_recent = flaky  # type: ignore[method-assign]

    status = await world.click_apply()

    assert status.state == "idle"
    assert status.scan_failures == 1
    assert status.sources_loaded == 2
    assert (CHAT_A, 1, rule.id) in world.matches()
    await world.live(CHAT_B, 2, "iphone B ao vivo")
    assert world.alerted_texts() == ["iphone B ao vivo"]  # config is live regardless


async def test_reapplying_is_idempotent_and_never_notifies_twice(
    db_path: Path, session: Session
) -> None:
    world = World(session, db_path)
    world.add_source(CHAT_A)
    world.add_rule("iphone")
    world.add_recipient("999")
    world.chats.post(CHAT_A, 1, "iphone historico", hours_ago=4)
    await world.boot()
    await world.live(CHAT_A, 2, "iphone ao vivo")
    assert world.alerted_texts() == ["iphone ao vivo"]
    before = (world.matches(), world.delivery_statuses())

    first = await world.click_apply()
    second = await world.click_apply()

    assert first.new_matches == 0 and second.new_matches == 0
    assert (world.matches(), world.delivery_statuses()) == before
    assert world.alerted_texts() == ["iphone ao vivo"]
    assert world.handler_registrations == 1


async def test_rejected_messages_leave_no_content_behind(db_path: Path, session: Session) -> None:
    world = World(session, db_path)
    world.add_source(CHAT_A)
    world.add_rule("iphone")
    world.add_recipient("999")
    await world.boot()
    world.add_rule("ps5")
    world.chats.post(CHAT_A, 1, "conteudo-rejeitado-unico-123 vende tudo", hours_ago=1)
    world.chats.post(CHAT_A, 2, "ps5 por R$ 100", hours_ago=1)

    await world.click_apply()
    await world.live(CHAT_A, 3, "outro-conteudo-rejeitado-456")

    world.session.expire_all()
    stored = list(world.session.scalars(select(Match.message_text)))
    assert stored == ["ps5 por R$ 100"]
    assert world.alerted_texts() == []


async def test_a_duplicate_request_is_applied_once(db_path: Path, session: Session) -> None:
    world = World(session, db_path)
    world.add_source(CHAT_A)
    world.add_rule("iphone")
    world.add_recipient("999")
    await world.boot()
    assert world.worker is not None

    with world.factory() as api_session:
        assert request_reload(api_session) is True
        assert request_reload(api_session) is False  # ignored while pending
    assert await world.worker.poll_once() is True
    assert await world.worker.poll_once() is False  # nothing left to claim
    with world.factory() as api_session:
        assert request_reload(api_session) is True  # free again after it finished


async def test_a_request_waits_while_the_listener_is_not_connected(
    db_path: Path, session: Session
) -> None:
    world = World(session, db_path)
    world.add_source(CHAT_A)
    world.add_rule("iphone")
    world.add_recipient("999")
    await world.boot()
    assert world.worker is not None
    world.connected = False

    world.add_rule("ps5")
    status = await world.click_apply()

    assert status.state == "pending"  # not lost, not failed: waiting for the connection
    assert status.listener_online is True  # the heartbeat keeps beating meanwhile
    world.connected = True
    assert await world.worker.poll_once() is True
    assert world.status().state == "idle"


async def test_reload_waits_for_a_catch_up_in_progress(db_path: Path, session: Session) -> None:
    """One lock covers both: a reconnect recovery never runs half old, half new."""
    world = World(session, db_path)
    world.add_source(CHAT_A)
    world.add_rule("iphone")
    world.add_recipient("999")
    await world.boot()
    assert world.lifecycle is not None
    world.add_rule("ps5")
    world.chats.block_iter_messages = asyncio.Event()

    catch_up = asyncio.create_task(world.lifecycle.catch_up())
    await asyncio.wait_for(world.chats.iter_messages_started.wait(), 5)
    reload_task = asyncio.create_task(world.click_apply())
    await asyncio.sleep(0.05)

    assert not reload_task.done()  # queued behind the catch-up
    assert len(world.lifecycle.sources[0].rules) == 1  # still the old configuration

    world.chats.block_iter_messages.set()
    await asyncio.wait_for(catch_up, 5)
    status = await asyncio.wait_for(reload_task, 5)

    assert status.state == "idle"
    assert len(world.lifecycle.sources[0].rules) == 2


async def test_the_boot_records_what_the_listener_loaded_and_settles_a_stuck_request(
    db_path: Path, session: Session
) -> None:
    world = World(session, db_path)
    world.add_source(CHAT_A)
    world.add_rule("iphone")
    world.add_recipient("999")
    with world.factory() as api_session:  # a previous process died mid-apply
        request_reload(api_session)
        row = api_session.get(ListenerControl, 1)
        assert row is not None
        row.state = "applying"
        api_session.commit()

    await world.boot()

    status = world.status()
    assert status.state == "idle"
    assert (status.sources_loaded, status.rules_loaded, status.recipients_loaded) == (1, 1, 1)
    assert status.has_unapplied_changes is False
    assert status.listener_online is True
    with world.factory() as check:
        assert check.scalar(select(func.count()).select_from(ListenerControl)) == 1
