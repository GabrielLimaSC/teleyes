"""Demo real: liga a sessão Telethon já autenticada ao pipeline completo.

Uso:
    python scripts/run_pipeline_demo.py \\
        --source-chat-id -1001234567890 --source-name "Grupo Teste" \\
        --rule-name "Demo" --include-terms "promo,promoção" \\
        --recipient-chat-id 123456789 --recipient-name "Gabriel"

Aplica as migrations pendentes (equivalente a `alembic upgrade head`), cadastra
(ou reaproveita, se já existirem) a fonte/regra/destinatário indicados, conecta
na sessão MTProto salva por scripts/telegram_login.py e escuta mensagens novas
do grupo indicado. Cada mensagem passa pelo pipeline completo (regras -> preço
-> dedupe -> persistência -> notificação) e o alerta é enviado de verdade pelo
bot via API HTTP do Telegram. Ctrl+C encerra.

Antes de começar a escutar ao vivo, e de novo depois de qualquer reconexão
detectada (S5-02), recupera mensagens perdidas desde o cursor persistido
(`packages/telegram/cursor.py`) — cobre tanto reiniciar o processo (o que foi
perdido enquanto estava parado) quanto uma queda de conexão curta (o real
`_handle_auto_reconnect` desta versão do Telethon não faz catch-up nenhum
sozinho, ver `packages/telegram/reconnect_watch.py`). Bounded por
`BACKFILL_MAX_MESSAGES`/`BACKFILL_MAX_AGE` — não reprocessa o histórico
inteiro do grupo.

Nenhum valor de TG_API_ID/TG_API_HASH/BOT_TOKEN é lido de argumento nem
hardcoded aqui — sempre vêm do .env. `--source-chat-id`/`--recipient-chat-id`
não são segredos (são só identificadores), por isso são argumentos normais.
"""

import argparse
import asyncio
import os
import sys
from datetime import timedelta
from pathlib import Path

from alembic import command
from alembic.config import Config
from dotenv import load_dotenv
from telethon import TelegramClient, events

from app.demo_setup import ensure_demo_setup
from app.pipeline import IncomingMessage, ListenerSource, catch_up_since_cursor, process_message
from models.db import get_engine, get_sessionmaker
from packages.notifications.bot import BotNotifier
from packages.notifications.http_client import HttpBotClient
from packages.rules.dedupe import DedupeCache
from packages.telegram.adapter import AdapterState, TelegramAdapter
from packages.telegram.reconnect_watch import supervise_reconnects
from packages.telegram.telethon_client import TelethonMessageFetcher, to_telegram_message

SESSION_PATH = Path("data/teleyes.session")
ALEMBIC_INI_PATH = Path(__file__).resolve().parents[1] / "apps" / "api" / "alembic.ini"
BACKFILL_MAX_MESSAGES = 100
BACKFILL_MAX_AGE = timedelta(hours=24)
RECONNECT_POLL_SECONDS = 15.0


def run_migrations() -> None:
    """Apply pending Alembic migrations before touching the database.

    Keeps this script self-contained: no separate manual `alembic upgrade
    head` step to remember before a demo run.
    """
    command.upgrade(Config(str(ALEMBIC_INI_PATH)), "head")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--source-chat-id", required=True, help="chat_id do grupo a monitorar")
    parser.add_argument("--source-name", default="Fonte de teste")
    parser.add_argument("--rule-name", default="Regra de teste")
    parser.add_argument("--include-terms", required=True, help="termos separados por vírgula")
    parser.add_argument("--exclude-terms", default=None)
    parser.add_argument("--max-price-cents", type=int, default=None)
    parser.add_argument(
        "--recipient-chat-id", required=True, help="chat_id de quem recebe o alerta"
    )
    parser.add_argument("--recipient-name", default="Destinatário de teste")
    return parser.parse_args()


async def main() -> None:
    load_dotenv()
    args = parse_args()

    api_id = os.environ.get("TG_API_ID")
    api_hash = os.environ.get("TG_API_HASH")
    bot_token = os.environ.get("BOT_TOKEN")
    if not api_id or not api_hash:
        print("TG_API_ID/TG_API_HASH ausentes — rode scripts/telegram_login.py primeiro.")
        sys.exit(1)
    if not bot_token:
        print("BOT_TOKEN ausente no .env.")
        sys.exit(1)

    run_migrations()
    session_factory = get_sessionmaker(get_engine())

    with session_factory() as setup_session:
        setup = ensure_demo_setup(
            setup_session,
            source_chat_id=args.source_chat_id,
            source_name=args.source_name,
            rule_name=args.rule_name,
            include_terms=args.include_terms,
            exclude_terms=args.exclude_terms,
            max_price_cents=args.max_price_cents,
            recipient_chat_id=args.recipient_chat_id,
            recipient_name=args.recipient_name,
        )
        setup_session.commit()
        print(f"Fonte: {setup.source.name} ({setup.source.telegram_chat_id})")
        print(f"Regra: {setup.rule.name} -> inclui [{setup.rule.include_terms}]")
        print(f"Destinatário: {setup.recipient.name} ({setup.recipient.telegram_chat_id})")

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
        allowlisted_chat_ids={setup.recipient.telegram_chat_id},
    )
    dedupe_cache = DedupeCache()
    fetcher = TelethonMessageFetcher(client)
    listener_source = ListenerSource(
        source_id=setup.source.id,
        chat_id=args.source_chat_id,
        rules=[setup.rule],
        recipients=[setup.recipient],
    )

    async def catch_up() -> None:
        recovered = await catch_up_since_cursor(
            session_factory,
            fetcher,
            listener_source,
            notifier,
            dedupe_cache,
            max_messages=BACKFILL_MAX_MESSAGES,
            max_age=BACKFILL_MAX_AGE,
        )
        if recovered:
            print(f"Recuperadas {len(recovered)} mensagens perdidas.")

    # Covers a process restart: whatever arrived while this run was down.
    await catch_up()

    print(f"Conectado. Escutando mensagens de {args.source_chat_id}... (Ctrl+C para sair)")

    @client.on(events.NewMessage(chats=int(args.source_chat_id)))
    async def handler(event: events.NewMessage.Event) -> None:
        telegram_message = to_telegram_message(event.message)
        with session_factory() as message_session:
            incoming = IncomingMessage(
                source_id=setup.source.id,
                message_id=telegram_message.id,
                text=telegram_message.text,
                link=None,
                received_at=telegram_message.date,
            )
            result = await process_message(
                message_session, incoming, setup.rule, [setup.recipient], notifier, dedupe_cache
            )
            message_session.commit()

            if result.match is not None:
                print(f"Match! match_id={result.match.id} entregas={result.deliveries_sent}")
            else:
                print(f"Descartado: {result.reason}")

    # Covers a short connection drop: this Telethon version's own auto-reconnect
    # doesn't catch up on missed updates by itself (see the module docstring
    # above and packages/telegram/reconnect_watch.py), so this polls the
    # client's own public is_connected() and re-runs catch-up whenever it
    # flips back to True.
    watchdog = asyncio.create_task(
        supervise_reconnects(
            client.is_connected,
            catch_up,
            poll_seconds=RECONNECT_POLL_SECONDS,
            sleep=asyncio.sleep,
        )
    )
    try:
        await client.run_until_disconnected()
    finally:
        watchdog.cancel()


if __name__ == "__main__":
    asyncio.run(main())
