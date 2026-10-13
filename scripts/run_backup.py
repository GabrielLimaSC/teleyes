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
import signal
import time
from pathlib import Path

from models.db import get_database_url
from packages.backup.sqlite_backup import apply_retention, run_backup_once

BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", "backups"))
BACKUP_INTERVAL_SECONDS = float(os.environ.get("BACKUP_INTERVAL_SECONDS", 6 * 60 * 60))
BACKUP_RETENTION_COUNT = int(os.environ.get("BACKUP_RETENTION_COUNT", 28))

class _StopRequested(Exception):
    pass


def _handle_stop_signal(signum: int, frame: object) -> None:
    # A process running as the container's PID 1 (docker/backup-entrypoint.sh
    # execs this directly) needs an *explicit* handler for a signal to reach
    # it at all — the kernel suppresses the default action of an unhandled
    # signal for PID 1 specifically (same root cause fixed in
    # scripts/run_listener.py, S5-09). Without this, `docker compose stop`/
    # `down` would sit through the full grace period and force-kill this
    # every time.
    #
    # Raising here, not just setting a flag, matters: PEP 475 (Python 3.5+)
    # makes time.sleep() automatically retry an interrupted syscall, so a
    # handler that only sets a flag would let the sleep below run out its
    # full multi-hour interval regardless — only a handler that raises
    # actually breaks out of it immediately (confirmed by actually hitting
    # this with a real Docker container: a flag-only version silently didn't
    # exit on SIGTERM, this raising version does).
    raise _StopRequested


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

    signal.signal(signal.SIGTERM, _handle_stop_signal)
    signal.signal(signal.SIGINT, _handle_stop_signal)

    db_path = _db_path_from_url(get_database_url())

    while True:
        run_cycle(db_path)
        if args.once:
            return
        try:
            time.sleep(BACKUP_INTERVAL_SECONDS)
        except _StopRequested:
            return


if __name__ == "__main__":
    main()
