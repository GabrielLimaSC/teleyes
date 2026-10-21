"""Semeia um banco de demonstração 100% fictício (S19-03).

Uso:
    python scripts/seed_demo.py --db data/demo.db [--force] [--now 2026-05-14T12:00:00+00:00]

Cria o schema (Alembic) no arquivo indicado e o preenche com regras, fontes,
destinatários, ~170 ofertas dos últimos 90 dias (relativos a "agora"), entregas,
contadores e o administrador da demonstração. O resultado é determinístico: o
mesmo `--now` sempre gera o mesmo conteúdo.

Idempotente: se o banco já tem os dados de demonstração, não faz nada. Recusa
qualquer banco que tenha fonte ou destinatário sem o marcador `demo:` (nem
`--force` passa por cima disso); `--force` só re-semeia um banco de demonstração
ou limpa sobras sem fonte/destinatário.

Só a API iniciada com TELEYES_DEMO=1 aceita esse banco, e só ela cria o login
público da demonstração.
"""

import argparse
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from alembic import command
from alembic.config import Config

from app.demo_mode import DEMO_PASSWORD
from app.demo_seed import UnsafeDatabaseError, content_hash, seed_demo_database
from models.db import get_engine, get_sessionmaker

ALEMBIC_INI_PATH = Path(__file__).resolve().parents[1] / "apps" / "api" / "alembic.ini"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--db", required=True, help="caminho do arquivo SQLite da demonstração")
    parser.add_argument("--force", action="store_true", help="re-semeia um banco de demonstração")
    parser.add_argument("--now", default=None, help="instante ISO 8601 usado como 'agora'")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db_path = Path(args.db).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    os.environ["DATABASE_URL"] = f"sqlite:///{db_path}"

    now = datetime.fromisoformat(args.now) if args.now else datetime.now(UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)

    command.upgrade(Config(str(ALEMBIC_INI_PATH)), "head")
    session_factory = get_sessionmaker(get_engine(os.environ["DATABASE_URL"]))
    try:
        summary = seed_demo_database(session_factory, now=now, force=args.force)
    except UnsafeDatabaseError as error:
        print(f"Recusado: {error}", file=sys.stderr)
        return 1

    with session_factory() as session:
        digest = content_hash(session)[:12]
    print(
        f"Demonstração pronta em {db_path}: {summary.sources} fontes, {summary.rules} regras, "
        f"{summary.matches} ofertas, {summary.deliveries} entregas (conteúdo {digest})."
    )
    print(f"Login do painel: senha '{DEMO_PASSWORD}' (só existe com TELEYES_DEMO=1).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
