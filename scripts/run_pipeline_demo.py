"""Demo real: liga a sessão Telethon já autenticada ao pipeline completo.

Uso:
    python scripts/run_pipeline_demo.py \\
        --source-chat-id -1001234567890 --source-name "Grupo Teste" \\
        --rule-name "Demo" --include-terms "promo,promoção" \\
        --recipient-chat-id 123456789 --recipient-name "Gabriel"

Cadastra (ou reaproveita, se já existirem) a fonte/regra/destinatário indicados,
conecta na sessão MTProto salva por scripts/telegram_login.py e escuta mensagens
novas do grupo indicado. Cada mensagem passa pelo pipeline completo (regras ->
preço -> dedupe -> persistência -> notificação) e o alerta é enviado de verdade
pelo bot via API HTTP do Telegram. Ctrl+C encerra.

Nenhum valor de TG_API_ID/TG_API_HASH/BOT_TOKEN é lido de argumento nem
hardcoded aqui — sempre vêm do .env. `--source-chat-id`/`--recipient-chat-id`
não são segredos (são só identificadores), por isso são argumentos normais.
"""

import argparse
import asyncio
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv
from telethon import TelegramClient, events

from app.demo_setup import ensure_demo_setup
from app.pipeline import IncomingMessage, process_message
from models.db import get_engine, get_sessionmaker
from packages.notifications.bot import BotNotifier
from packages.notifications.http_client import HttpBotClient
from packages.rules.dedupe import DedupeCache
from packages.telegram.adapter import AdapterState, TelegramAdapter

SESSION_PATH = Path("data/teleyes.session")


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

    print(f"Conectado. Escutando mensagens de {args.source_chat_id}... (Ctrl+C para sair)")

    @client.on(events.NewMessage(chats=int(args.source_chat_id)))
    async def handler(event: events.NewMessage.Event) -> None:
        with session_factory() as message_session:
            incoming = IncomingMessage(
                source_id=setup.source.id,
                message_id=event.message.id,
                text=event.message.text or "",
                link=None,
                received_at=datetime.now(UTC),
            )
            result = await process_message(
                message_session, incoming, setup.rule, [setup.recipient], notifier, dedupe_cache
            )
            message_session.commit()

            if result.match is not None:
                print(f"Match! match_id={result.match.id} entregas={result.deliveries_sent}")
            else:
                print(f"Descartado: {result.reason}")

    await client.run_until_disconnected()


if __name__ == "__main__":
    asyncio.run(main())
