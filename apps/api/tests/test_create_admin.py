import sys
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from auth.hashing import verify_password
from models import Admin

# scripts/ isn't a package under apps/api (pytest's pythonpath), so it's not
# importable the normal way — added to sys.path just for this test file,
# mirroring how scripts/ is a thin, untested-elsewhere CLI wrapper around
# logic worth covering directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from create_admin import upsert_admin_password  # type: ignore[import-not-found]  # noqa: E402


def test_creates_the_first_admin_when_none_exists(session: Session) -> None:
    action = upsert_admin_password(session, "senha-do-gabriel")
    session.commit()

    assert action == "criado"
    admin = session.scalar(select(Admin))
    assert admin is not None
    assert verify_password("senha-do-gabriel", admin.password_hash) is True


def test_updates_the_existing_admin_instead_of_creating_a_second_row(session: Session) -> None:
    upsert_admin_password(session, "senha-antiga")
    session.commit()

    action = upsert_admin_password(session, "senha-nova")
    session.commit()

    assert action == "atualizado"
    admins = session.scalars(select(Admin)).all()
    assert len(admins) == 1
    assert verify_password("senha-nova", admins[0].password_hash) is True
    assert verify_password("senha-antiga", admins[0].password_hash) is False
