from sqlalchemy.orm import Session

from auth.hashing import hash_password, verify_password
from models import Admin


def test_hash_password_never_stores_the_plaintext() -> None:
    password_hash = hash_password("correct horse battery staple")

    assert "correct horse battery staple" not in password_hash
    assert password_hash.startswith("$argon2")


def test_verify_password_accepts_the_correct_password() -> None:
    password_hash = hash_password("correct horse battery staple")

    assert verify_password("correct horse battery staple", password_hash) is True


def test_verify_password_rejects_a_wrong_password() -> None:
    password_hash = hash_password("correct horse battery staple")

    assert verify_password("wrong password", password_hash) is False


def test_admin_row_only_ever_stores_a_hash(session: Session) -> None:
    plaintext = "correct horse battery staple"
    admin = Admin(password_hash=hash_password(plaintext))
    session.add(admin)
    session.commit()

    stored = session.get(Admin, admin.id)
    assert stored is not None
    assert stored.password_hash != plaintext
    assert plaintext not in stored.password_hash


def test_login_with_correct_password_succeeds(session: Session) -> None:
    admin = Admin(password_hash=hash_password("correct horse battery staple"))
    session.add(admin)
    session.commit()

    stored = session.get(Admin, admin.id)
    assert stored is not None
    assert verify_password("correct horse battery staple", stored.password_hash) is True


def test_login_with_wrong_password_never_authenticates_even_with_hash_exposed(
    session: Session,
) -> None:
    admin = Admin(password_hash=hash_password("correct horse battery staple"))
    session.add(admin)
    session.commit()

    stored = session.get(Admin, admin.id)
    assert stored is not None
    # The attacker has the hash (as if leaked) but not the password.
    assert verify_password("guess1", stored.password_hash) is False
    assert verify_password("guess2", stored.password_hash) is False
    assert verify_password("", stored.password_hash) is False
