"""Cria ou redefine a senha do administrador único do painel (S5-07).

Uso:
    python scripts/create_admin.py

Pede a senha interativamente (nunca como argumento de linha de comando, pra
não sobrar em histórico de shell) e confirma digitando duas vezes. Se já
existir uma linha de `Admin`, atualiza a senha dela em vez de criar uma
segunda — o schema permite só um administrador (v1 não tem multiusuário, ver
apps/api/models/admin.py), então isto é sempre "criar ou redefinir", nunca
"criar mais um".

Sem isso, não existe nenhum jeito suportado de logar no painel pela primeira
vez: `POST /auth/login` só verifica contra a única linha de `admin` que já
existir, e nada no fluxo de onboarding anterior a esta task criava essa
linha.
"""

import argparse
import getpass
import os
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.demo_mode import DEMO_PASSWORD
from auth.hashing import hash_password
from models import Admin
from models.db import get_engine, get_sessionmaker

MIN_PASSWORD_LENGTH = 8


def upsert_admin_password(session: Session, password: str) -> str:
    """Create the single Admin row, or overwrite its password if one exists.

    Returns "criado" or "atualizado" for the caller to report. Session isn't
    committed here — the caller controls that, same convention as
    `app.pipeline.process_message`.
    """
    admin = session.scalar(select(Admin))
    if admin is None:
        session.add(Admin(password_hash=hash_password(password)))
        return "criado"
    admin.password_hash = hash_password(password)
    return "atualizado"


PASSWORD_ENV_VAR = "TELEYES_ADMIN_PASSWORD"
EXIT_NO_ADMIN = 3


def admin_exists() -> bool:
    session_factory = get_sessionmaker(get_engine())
    with session_factory() as session:
        return session.scalar(select(Admin)) is not None


def validate_password(password: str) -> str | None:
    """Return the reason the password is unacceptable, or None when it is fine."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Senha precisa ter pelo menos {MIN_PASSWORD_LENGTH} caracteres."
    if password == DEMO_PASSWORD:
        return "Essa é a senha pública da demonstração; escolha outra para um painel real."
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument(
        "--check",
        action="store_true",
        help=f"só informa se já existe admin (exit 0 = existe, {EXIT_NO_ADMIN} = não existe)",
    )
    args = parser.parse_args()
    if args.check:
        sys.exit(0 if admin_exists() else EXIT_NO_ADMIN)

    # S19-01: install.sh passes the password through the environment (never argv),
    # so it can run non-interactively. Without it, prompt as before.
    from_env = os.environ.get(PASSWORD_ENV_VAR)
    if from_env:
        password = from_env
        problem = validate_password(password)
        if problem:
            print(problem)
            sys.exit(1)
    else:
        password = getpass.getpass("Senha do painel: ")
        problem = validate_password(password)
        if problem:
            print(problem)
            sys.exit(1)
        confirm = getpass.getpass("Confirme a senha: ")
        if password != confirm:
            print("Senhas não coincidem.")
            sys.exit(1)

    session_factory = get_sessionmaker(get_engine())
    with session_factory() as session:
        action = upsert_admin_password(session, password)
        session.commit()

    print(f"Admin {action}. Faça login no painel com a senha definida.")


if __name__ == "__main__":
    main()
