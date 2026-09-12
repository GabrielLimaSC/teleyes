"""Backup rotativo do SQLite de produção (S5-03).

Uso:
    python scripts/run_backup.py           # loop indefinido (sidecar)
    python scripts/run_backup.py --once    # um ciclo só, pra teste manual

Sem argumentos além de --once: roda um ciclo de backup e dorme
BACKUP_INTERVAL_SECONDS entre ciclos, indefinidamente — pensado pra rodar
como o container sidecar `backup` do docker-compose.prod.yml em vez de
depender de agendador do host (Windows não tem `cron` nativo; o Agendador de
Tarefas fica pra S5-06, não pra isso).

A lógica de backup em si (`VACUUM INTO` + rotação) está em
`packages/backup/sqlite_backup.py`, testada com pytest — este script é só o
laço de repetição e a leitura de configuração via ambiente.

Cadência padrão: a cada 6h, retendo as últimas 28 (7 dias de cobertura). Uma
janela curta o bastante pra não perder muito entre backups, um número de
cópias generoso o bastante pra sobreviver a um erro só percebido dias depois
— o banco é pequeno (metadados de match, não mídia), então reter 28 cópias
custa pouco disco.
"""

import argparse
import os
import time
from pathlib import Path

from models.db import get_database_url
from packages.backup.sqlite_backup import apply_retention, run_backup_once

BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", "backups"))
BACKUP_INTERVAL_SECONDS = float(os.environ.get("BACKUP_INTERVAL_SECONDS", 6 * 60 * 60))
BACKUP_RETENTION_COUNT = int(os.environ.get("BACKUP_RETENTION_COUNT", 28))


def _db_path_from_url(url: str) -> Path:
    prefix = "sqlite:///"
    if not url.startswith(prefix):
        raise ValueError(f"backup só suporta sqlite, recebeu DATABASE_URL={url!r}")
    return Path(url[len(prefix) :])


def run_cycle(db_path: Path) -> None:
    if not db_path.exists():
        print(f"Banco {db_path} não existe ainda — nada pra fazer backup.")
        return

    backup_path = run_backup_once(db_path, BACKUP_DIR)
    deleted = apply_retention(BACKUP_DIR, keep=BACKUP_RETENTION_COUNT)
    message = f"Backup criado: {backup_path.name}"
    if deleted:
        message += f"; removido(s) {len(deleted)} backup(s) antigo(s)"
    print(message)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="roda um ciclo e sai")
    args = parser.parse_args()

    db_path = _db_path_from_url(get_database_url())

    while True:
        run_cycle(db_path)
        if args.once:
            return
        time.sleep(BACKUP_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
