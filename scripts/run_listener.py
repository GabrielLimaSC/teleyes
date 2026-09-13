"""Processo de longa duração do listener de produção (S5-09).

Uso:
    python scripts/run_listener.py

Sem argumentos: toda configuração vem do banco, cadastrada pelo painel web
(S4-06) — fontes, regras e destinatários ativos (destinatário também precisa
estar allowlisted). Diferente de scripts/run_pipeline_demo.py, que recebe
uma única fonte/regra/destinatário via CLI pensado pra teste manual pontual.

O schema não tem relação estática regra<->fonte nem regra<->destinatário
(conferido em apps/api/models/*.py e nos routers de CRUD antes de escrever
isto) — é "toda regra ativa contra toda mensagem de toda fonte ativa, entrega
pra todo destinatário ativo e allowlisted", modelo consistente com um único
administrador (CLAUDE.md). Configuração é lida uma vez no start: adicionar ou
mudar fonte/regra/destinatário pelo painel exige reiniciar este processo pra
valer — limitação conhecida, documentada aqui e em TESTING.md, não escondida.

Faz catch-up (packages/telegram/cursor.py, S5-02) uma vez no boot — cobre
reiniciar o processo — e de novo sempre que o watchdog de reconexão
(packages/telegram/reconnect_watch.py) detectar que a conexão caiu e voltou —
cobre uma queda curta. Bounded por BACKFILL_MAX_MESSAGES/BACKFILL_MAX_AGE, não
reprocessa o histórico inteiro de nenhum grupo.

Sem TG_API_ID/TG_API_HASH/BOT_TOKEN configurados, encerra imediatamente com
uma mensagem clara — nunca finge ter conectado. Sem nenhuma fonte, regra ou
destinatário ativo cadastrado, também encerra (nada pra escutar).

Migrations não são aplicadas aqui: docker-compose.prod.yml garante, via
`depends_on: api: condition: service_healthy`, que o serviço `api` (que já
roda `alembic upgrade head` no seu próprio entrypoint) sobe primeiro — dois
processos rodando migração ao mesmo tempo contra o mesmo arquivo SQLite seria
uma corrida real, não uma preocupação teórica.
"""

import asyncio
import os
import signal
import sys
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import select
from sqlalchemy.orm import Session
from telethon import TelegramClient, events

from app.pipeline import IncomingMessage, ListenerSource, catch_up_since_cursor, process_message
from models import Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.monitoring.heartbeat import load_heartbeat_config, run_heartbeat
from packages.notifications.bot import BotNotifier
from packages.notifications.http_client import HttpBotClient
from packages.rules.dedupe import DedupeCache
from packages.telegram.adapter import AdapterState, TelegramAdapter
from packages.telegram.reconnect_watch import supervise_reconnects
from packages.telegram.telethon_client import TelethonMessageFetcher, to_telegram_message

SESSION_PATH = Path("data/teleyes.session")
BACKFILL_MAX_MESSAGES = 100
BACKFILL_MAX_AGE = timedelta(hours=24)
RECONNECT_POLL_SECONDS = 15.0


def _load_active_config(session: Session) -> tuple[list[Source], list[Rule], list[Recipient]]:
    sources = list(session.scalars(select(Source).where(Source.active.is_(True))))
    rules = list(session.scalars(select(Rule).where(Rule.active.is_(True))))
    recipients = list(
        session.scalars(
            select(Recipient).where(
                Recipient.active.is_(True), Recipient.allowlisted.is_(True)
            )
        )
    )
    return sources, rules, recipients


async def _idle_until_stopped(
    stop_event: asyncio.Event, message: str, *, remind_every: float = 300.0
) -> None:
    """Stay up quietly instead of exiting.

    `restart: unless-stopped` (docker-compose.prod.yml) restarts a container
    on *any* exit, success included — not just failures. Exiting the moment
    something's `not_configured` would turn into a restart-loop (repeatedly
    starting, printing one line, exiting, over and over) instead of the same
    calm, honestly-idle-but-up state `app.main`'s FastAPI service already
    reports via `GET /health` for the exact same conditions. Returns as soon
    as `stop_event` fires (see `main`'s signal handlers) rather than blocking
    a graceful shutdown for up to `remind_every`.
    """
    print(message)
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=remind_every)
        except TimeoutError:
            print(message)


async def main() -> None:
    load_dotenv()

    # A process running as the container's PID 1 (docker/listener-entrypoint.sh
    # execs this directly) needs an *explicit* handler for a signal to reach
    # it at all: the kernel suppresses the default action of an unhandled
    # signal for PID 1 specifically, so without this, `docker stop`/`compose
    # down`/a real SIGTERM-based crash test would all silently do nothing
    # until the grace period expires and Docker escalates to SIGKILL. `api`
    # (uvicorn) never hit this because uvicorn already installs its own
    # SIGTERM/SIGINT handlers.
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)

    api_id = os.environ.get("TG_API_ID")
    api_hash = os.environ.get("TG_API_HASH")
    bot_token = os.environ.get("BOT_TOKEN")
    if not api_id or not api_hash:
        await _idle_until_stopped(
            stop_event, "TG_API_ID/TG_API_HASH ausentes — not_configured, sem fingir conexão."
        )
        return
    if not bot_token:
        await _idle_until_stopped(
            stop_event, "BOT_TOKEN ausente — not_configured, sem fingir conexão."
        )
        return

    session_factory = get_sessionmaker(get_engine())

    with session_factory() as session:
        sources, rules, recipients = _load_active_config(session)

    if not sources or not rules or not recipients:
        await _idle_until_stopped(
            stop_event,
            "Sem fonte, regra ou destinatário (ativo e allowlisted) cadastrado — nada pra "
            "escutar. Cadastre pelo painel e reinicie este processo pra pegar a mudança.",
        )
        return

    print(f"{len(sources)} fonte(s), {len(rules)} regra(s), {len(recipients)} destinatário(s).")

    client = TelegramClient(str(SESSION_PATH), int(api_id), api_hash)
    adapter = TelegramAdapter(
        api_id=int(api_id), api_hash=api_hash, client=client, sleep=asyncio.sleep
    )

    state = await adapter.connect()
    if state is not AdapterState.CONNECTED:
        print(f"Não foi possível conectar (estado: {state.value}).")
        sys.exit(1)

    notifier = BotNotifier(
        bot_token=bot_token,
        client=HttpBotClient(bot_token),
        allowlisted_chat_ids={recipient.telegram_chat_id for recipient in recipients},
    )
    dedupe_cache = DedupeCache()
    fetcher = TelethonMessageFetcher(client)
    listener_sources = [
        ListenerSource(
            source_id=source.id,
            chat_id=source.telegram_chat_id,
            rules=rules,
            recipients=recipients,
        )
        for source in sources
    ]

    async def catch_up() -> None:
        total = 0
        for listener_source in listener_sources:
            recovered = await catch_up_since_cursor(
                session_factory,
                fetcher,
                listener_source,
                notifier,
                dedupe_cache,
                max_messages=BACKFILL_MAX_MESSAGES,
                max_age=BACKFILL_MAX_AGE,
            )
            total += len(recovered)
        if total:
            print(f"Recuperadas {total} avaliações de mensagens perdidas.")

    # Covers a process restart: whatever arrived while this run was down.
    await catch_up()

    sources_by_chat_id = {int(source.telegram_chat_id): source for source in sources}
    chat_ids = list(sources_by_chat_id.keys())
    print(f"Conectado. Escutando {len(chat_ids)} grupo(s)... (Ctrl+C para sair)")

    @client.on(events.NewMessage(chats=chat_ids))
    async def handler(event: events.NewMessage.Event) -> None:
        source = sources_by_chat_id[event.chat_id]
        telegram_message = to_telegram_message(event.message)
        for rule in rules:
            with session_factory() as message_session:
                incoming = IncomingMessage(
                    source_id=source.id,
                    message_id=telegram_message.id,
                    text=telegram_message.text,
                    link=None,
                    received_at=telegram_message.date,
                )
                result = await process_message(
                    message_session, incoming, rule, recipients, notifier, dedupe_cache
                )
                message_session.commit()

                if result.match is not None:
                    print(
                        f"Match! fonte={source.name} regra={rule.name} "
                        f"match_id={result.match.id} entregas={result.deliveries_sent}"
                    )

    # Covers a short connection drop: this Telethon version's own auto-reconnect
    # doesn't catch up on missed updates by itself (see reconnect_watch.py), so
    # this polls the client's own public is_connected() and re-runs catch-up
    # whenever it flips back to True.
    watchdog = asyncio.create_task(
        supervise_reconnects(
            client.is_connected,
            catch_up,
            poll_seconds=RECONNECT_POLL_SECONDS,
            sleep=asyncio.sleep,
        )
    )
    heartbeat = asyncio.create_task(
        run_heartbeat(load_heartbeat_config(), client.is_connected, stop_event)
    )
    stop_waiter = asyncio.create_task(stop_event.wait())
    disconnected_waiter = asyncio.create_task(client.run_until_disconnected())
    try:
        await asyncio.wait(
            {stop_waiter, disconnected_waiter}, return_when=asyncio.FIRST_COMPLETED
        )
        if not disconnected_waiter.done():
            # stop_event fired first (a real signal) — ask Telethon to close
            # the connection itself instead of just cancelling our waiter task,
            # so run_until_disconnected's own cleanup (client.disconnect()
            # internally) still runs.
            await client.disconnect()
            await disconnected_waiter
    finally:
        stop_event.set()
        watchdog.cancel()
        heartbeat.cancel()
        stop_waiter.cancel()
        await asyncio.gather(watchdog, heartbeat, stop_waiter, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
