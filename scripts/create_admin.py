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

import getpass
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

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


def main() -> None:
    password = getpass.getpass("Senha do painel: ")
    if len(password) < MIN_PASSWORD_LENGTH:
        print(f"Senha precisa ter pelo menos {MIN_PASSWORD_LENGTH} caracteres.")
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
