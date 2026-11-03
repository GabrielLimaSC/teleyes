import sys
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from auth.hashing import verify_password
from auth.session import SessionStore
from models import Admin, AdminSession

# scripts/ isn't a package under apps/api (pytest's pythonpath), so it's not
# importable the normal way — added to sys.path just for this test file,
# mirroring how scripts/ is a thin, untested-elsewhere CLI wrapper around
# logic worth covering directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from create_admin import (  # type: ignore[import-not-found]  # noqa: E402
    DEMO_PASSWORD,
    MIN_PASSWORD_LENGTH,
    upsert_admin_password,
    validate_password,
)


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


def test_validate_password_accepts_a_normal_password() -> None:
    assert validate_password("x" * MIN_PASSWORD_LENGTH) is None


def test_validate_password_rejects_short_and_demo_passwords() -> None:
    assert validate_password("curta") is not None
    assert validate_password(DEMO_PASSWORD) is not None


def test_resetting_the_password_signs_every_session_out(session: Session) -> None:
    # S21-12: sessions are persistent now, so a stolen "manter conectado" cookie would
    # otherwise survive the password change meant to lock the thief out.
    upsert_admin_password(session, "senha-antiga")
    session.commit()
    admin_id = session.scalars(select(Admin)).one().id
    store = SessionStore(sessionmaker(bind=session.get_bind()))
    remembered = store.create_session(admin_id, remember=True)
    plain = store.create_session(admin_id)

    action = upsert_admin_password(session, "senha-nova")
    session.commit()

    assert action == "atualizado"
    assert store.get_session(remembered.session_id) is None
    assert store.get_session(plain.session_id) is None
    assert session.scalars(select(AdminSession)).all() == []
