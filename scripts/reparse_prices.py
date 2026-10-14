"""Reprocessa o preço dos matches salvos com o extrator atual.

Uso:
    python scripts/reparse_prices.py            # só mostra o que mudaria
    python scripts/reparse_prices.py --apply    # faz backup e grava

Preços editados manualmente nunca são alterados. Não envia alerta.
"""

import argparse
from pathlib import Path

from app.reparse_prices import reparse_prices
from models.db import get_database_url, get_sessionmaker
from packages.backup.sqlite_backup import run_backup_once


def _format_cents(value: int | None) -> str:
    if value is None:
        return "—"
    reais, cents = divmod(value, 100)
    return f"R$ {reais:,}".replace(",", ".") + f",{cents:02d}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="grava as mudanças (faz backup antes)")
    parser.add_argument("--backup-dir", default="backups", help="pasta do backup prévio")
    args = parser.parse_args()

    if args.apply:
        database_url = get_database_url()
        db_path = Path(database_url.removeprefix("sqlite:///"))
        backup = run_backup_once(db_path, Path(args.backup_dir))
        print(f"Backup antes de gravar: {backup}")

    with get_sessionmaker()() as session:
        changes = reparse_prices(session, apply=args.apply)

    for change in changes:
        print(
            f"match {change.match_id}: {_format_cents(change.before[0])} -> "
            f"{_format_cents(change.after[0])} (à vista/cartão antes {change.before[1:]}, "
            f"depois {change.after[1:]})"
        )
    verb = "Alterados" if args.apply else "Seriam alterados (rode com --apply para gravar)"
    print(f"{verb}: {len(changes)} match(es).")


if __name__ == "__main__":
    main()
