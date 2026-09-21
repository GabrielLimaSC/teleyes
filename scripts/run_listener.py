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
reiniciar o processo — e de novo sempre que a conexão cair e voltar — cobre uma
queda curta. Bounded por BACKFILL_MAX_MESSAGES/BACKFILL_MAX_AGE, não
reprocessa o histórico inteiro de nenhum grupo. No boot, uma fonte sem cursor
persistido ainda (nunca processada ao vivo antes) nunca passa por esse
catch-up notificante — teria tratado toda sua história recente como "perdida
numa queda" e mandado alerta retroativo de verdade (S6-04). Em vez disso, o
cursor dela é só inicializado na ponta mais recente do chat, sem notificar
nada; o histórico recente dessa fonte nova continua aparecendo só via o scan
não notificante abaixo.

S13-02: perder a conexão com o Telegram NÃO encerra o processo. O Telethon
desiste depois do orçamento curto dele (5 tentativas, ~7s) e levanta
`ConnectionError`; antes isso escapava (no boot, de `adapter.connect()`; em
execução, de `run_until_disconnected()`, cuja exceção ninguém recuperava) e o
processo terminava, o Docker o reiniciava e o scan de 7 dias era refeito a cada
queda.
Agora `packages/telegram/connection_supervisor.py` reconecta dentro do
processo com backoff exponencial (5s -> 300s, com jitter), registra o motivo
de cada tentativa e só escala a `blocked` (e encerra) depois de
`CONNECT_BACKOFF.max_consecutive_failures` falhas seguidas. Reconexão só faz o
catch-up por cursor (`app.listener_lifecycle`), nunca o scan de 7 dias.

Também roda, uma vez por fonte logo após registrar o handler ao vivo, um scan
histórico independente do cursor (S6-02): reavalia os últimos
HISTORICAL_WINDOW (7 dias por padrão desde a S7-04; era 24h na S6-02
original) de cada fonte ativa contra toda regra ativa, persiste os matches e
cria Delivery(status="historical") por destinatário aplicável, mas nunca
chama o BotNotifier — sem alerta retroativo. Repetir esse scan num restart
não duplica (identidade persistente da S6-01). Não confundir com
BACKFILL_MAX_AGE abaixo, que continua em 24h — propósito diferente, o teto
de uma reconexão curta de verdade, não de quanto histórico uma fonte nova
ganha na primeira instalação.

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
import logging
import os
import sys
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import select
from sqlalchemy.orm import Session
from telethon import TelegramClient, events

from app.listener_lifecycle import ListenerLifecycle
from app.pipeline import (
    IncomingMessage,
    ListenerSource,
    process_message,
)
from models import Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.monitoring.heartbeat import load_heartbeat_config, run_heartbeat
from packages.notifications.bot import BotNotifier
from packages.notifications.http_client import HttpBotClient
from packages.rules.dedupe import DedupeCache
from packages.telegram.adapter import TelegramAdapter
from packages.telegram.connection_supervisor import (
    BackoffPolicy,
    ConnectionSupervisor,
    SupervisorOutcome,
    install_stop_signal_handlers,
)
from packages.telegram.links import build_message_link
from packages.telegram.reconnect_watch import supervise_reconnects
from packages.telegram.telethon_client import TelethonMessageFetcher, to_telegram_message

SESSION_PATH = Path("data/teleyes.session")
BACKFILL_MAX_MESSAGES = 100
BACKFILL_MAX_AGE = timedelta(hours=24)
RECONNECT_POLL_SECONDS = 15.0
# S7-04: 7 days, not 24h — widened after Gabriel's homologation feedback.
# Unrelated to BACKFILL_MAX_AGE above, which stays 24h on purpose (a real
# reconnect's gap, not a fresh source's first historical scan).
HISTORICAL_WINDOW = timedelta(days=7)
# S13-02: 5s doubling up to 5min between attempts, 30 failures in a row (a bit
# over two hours of continuous outage) before escalating to `blocked`.
CONNECT_BACKOFF = BackoffPolicy(base_seconds=5.0, max_seconds=300.0, max_consecutive_failures=30)


def _configure_logging() -> None:
    """Warnings and up for everything (Telethon's included), plus the
    supervisor's own INFO events (connected / reconnect scheduled / stopped)."""
    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logging.getLogger("packages.telegram.connection_supervisor").setLevel(logging.INFO)
    logging.getLogger("app.listener_lifecycle").setLevel(logging.INFO)


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


async def main() -> int:
    """Returns the process exit code: 0 on a requested stop, 1 once `blocked`."""
    load_dotenv()
    _configure_logging()

    # A process running as the container's PID 1 (docker/listener-entrypoint.sh
    # execs this directly) needs an *explicit* handler for a signal to reach
    # it at all: the kernel suppresses the default action of an unhandled
    # signal for PID 1 specifically, so without this, `docker stop`/`compose
    # down`/a real SIGTERM-based crash test would all silently do nothing
    # until the grace period expires and Docker escalates to SIGKILL. `api`
    # (uvicorn) never hit this because uvicorn already installs its own
    # SIGTERM/SIGINT handlers. The handler only sets an event, so it can't raise.
    stop_event = asyncio.Event()
    install_stop_signal_handlers(asyncio.get_running_loop(), stop_event)

    api_id = os.environ.get("TG_API_ID")
    api_hash = os.environ.get("TG_API_HASH")
    bot_token = os.environ.get("BOT_TOKEN")
    if not api_id or not api_hash:
        await _idle_until_stopped(
            stop_event, "TG_API_ID/TG_API_HASH ausentes — not_configured, sem fingir conexão."
        )
        return 0
    if not bot_token:
        await _idle_until_stopped(
            stop_event, "BOT_TOKEN ausente — not_configured, sem fingir conexão."
        )
        return 0

    session_factory = get_sessionmaker(get_engine())

    with session_factory() as session:
        sources, rules, recipients = _load_active_config(session)

    if not sources or not rules or not recipients:
        await _idle_until_stopped(
            stop_event,
            "Sem fonte, regra ou destinatário (ativo e allowlisted) cadastrado — nada pra "
            "escutar. Cadastre pelo painel e reinicie este processo pra pegar a mudança.",
        )
        return 0

    print(f"{len(sources)} fonte(s), {len(rules)} regra(s), {len(recipients)} destinatário(s).")

    client = TelegramClient(str(SESSION_PATH), int(api_id), api_hash)
    adapter = TelegramAdapter(
        api_id=int(api_id), api_hash=api_hash, client=client, sleep=asyncio.sleep
    )

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

    sources_by_chat_id = {int(source.telegram_chat_id): source for source in sources}
    chat_ids = list(sources_by_chat_id.keys())

    def register_live_handler() -> None:
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
                        link=build_message_link(source.telegram_chat_id, telegram_message.id),
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

        print(f"Conectado. Escutando {len(chat_ids)} grupo(s)... (Ctrl+C para sair)")

    lifecycle = ListenerLifecycle(
        session_factory=session_factory,
        fetcher=fetcher,
        sources=listener_sources,
        notifier=notifier,
        dedupe_cache=dedupe_cache,
        register_live_handler=register_live_handler,
        backfill_max_messages=BACKFILL_MAX_MESSAGES,
        backfill_max_age=BACKFILL_MAX_AGE,
        historical_window=HISTORICAL_WINDOW,
    )

    watchdog: asyncio.Task[None] | None = None

    async def on_connected() -> None:
        nonlocal watchdog
        await lifecycle.on_connected()
        if watchdog is None:
            # Covers a *silent* short drop: this Telethon version's own
            # auto-reconnect doesn't catch up on missed updates by itself (see
            # reconnect_watch.py), so this polls the client's public
            # is_connected() and re-runs catch-up whenever it flips back to
            # True. Only started once boot is done — before that, the first
            # connection would look like a "reconnect" and run the notifying
            # catch-up on sources that have no cursor yet (S6-04).
            watchdog = asyncio.create_task(
                supervise_reconnects(
                    client.is_connected,
                    lifecycle.catch_up,
                    poll_seconds=RECONNECT_POLL_SECONDS,
                    sleep=asyncio.sleep,
                )
            )

    supervisor = ConnectionSupervisor(
        adapter,
        wait_until_disconnected=client.run_until_disconnected,
        on_connected=on_connected,
        stop_event=stop_event,
        policy=CONNECT_BACKOFF,
    )
    heartbeat = asyncio.create_task(
        run_heartbeat(load_heartbeat_config(), client.is_connected, stop_event)
    )
    try:
        outcome = await supervisor.run()
    finally:
        stop_event.set()
        background = [task for task in (watchdog, heartbeat) if task is not None]
        for task in background:
            task.cancel()
        await asyncio.gather(*background, return_exceptions=True)

    return 1 if outcome is SupervisorOutcome.BLOCKED else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
