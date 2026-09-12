from auth.session import SessionRecord


def verify_csrf_token(session: SessionRecord, provided_token: str | None) -> bool:
    """True only if `provided_token` matches the token issued for this session."""
    return provided_token is not None and provided_token == session.csrf_token
