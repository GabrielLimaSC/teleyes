"""Login interativo do Telethon para criar/renovar a sessão MTProto local.

Uso:
    python scripts/telegram_login.py

Pede telefone, código de confirmação (SMS/app) e senha 2FA (se houver)
diretamente no terminal — nada disso deve ser colado em chat com o assistente.
Ao final, a sessão fica salva em `data/teleyes.session` (fora do Git) e o
script lista os últimos diálogos visíveis para confirmar que o grupo alvo
aparece para esta conta.
"""

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from telethon import TelegramClient

SESSION_PATH = Path("data/teleyes.session")


async def main() -> None:
    load_dotenv()

    api_id = os.environ.get("TG_API_ID")
    api_hash = os.environ.get("TG_API_HASH")
    if not api_id or not api_hash:
        print("TG_API_ID/TG_API_HASH ausentes — preencha o .env antes de rodar este login.")
        sys.exit(1)

    SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)

    client = TelegramClient(str(SESSION_PATH), int(api_id), api_hash)
    await client.start()  # pede telefone/código/2FA aqui mesmo, no terminal

    me = await client.get_me()
    first_name = getattr(me, "first_name", me)
    user_id = getattr(me, "id", "?")
    print(f"Login ok: conectado como {first_name} (id={user_id}).")
    print(f"Sessão salva em {SESSION_PATH} — nunca commitar este arquivo.")

    print("\nÚltimos diálogos visíveis (confirme que o grupo alvo aparece aqui):")
    async for dialog in client.iter_dialogs(limit=10):
        print(f"  - {dialog.name} (id={dialog.id})")

    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
