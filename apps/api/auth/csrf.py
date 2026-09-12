import secrets

from auth.session import SessionRecord


def verify_csrf_token(session: SessionRecord, provided_token: str | None) -> bool:
    """True only if `provided_token` matches the token issued for this session."""
    if provided_token is None:
        return False
    return secrets.compare_digest(provided_token, session.csrf_token)
