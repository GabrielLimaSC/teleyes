"""S23-01: route-level security invariants, checked against the whole application.

Walking `app.routes` (instead of listing endpoints by hand) means a route added later
without a session or a CSRF check fails here, without anyone having to remember to
extend a list.
"""

import re

import pytest
from tests.match_api_support import ApiContext, api  # noqa: F401  (fixture)

from app.main import app

MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# The only endpoints reachable without a session. Everything else must answer 401.
PUBLIC: set[tuple[str, str]] = {
    ("GET", "/health"),
    ("POST", "/auth/login"),
    ("GET", "/openapi.json"),
    ("GET", "/docs"),
    ("GET", "/docs/oauth2-redirect"),
    ("GET", "/redoc"),
    # Static HTML shell of the simulator (include_in_schema=False, so it is added by hand
    # below); every call it makes is authenticated and CSRF-protected.
    ("GET", "/demo"),
}


def _endpoints() -> list[tuple[str, str]]:
    """Every method+path in the OpenAPI document (FastAPI keeps included routers lazy, so
    `app.routes` no longer lists them) plus the one route hidden from the schema."""
    found = [
        (method.upper(), path)
        for path, operations in app.openapi()["paths"].items()
        for method in operations
        if method.upper() in {"GET", "POST", "PUT", "PATCH", "DELETE"}
    ]
    return found + [("GET", "/demo")]


def _concrete(path: str) -> str:
    """Fill path parameters with a dummy value."""
    return re.sub(r"\{[^}]+\}", "1", path)


ENDPOINTS = _endpoints()
MUTATING = [e for e in ENDPOINTS if e[0] in MUTATING_METHODS and e not in PUBLIC]
PROTECTED = [e for e in ENDPOINTS if e not in PUBLIC]


def test_the_route_walk_sees_the_application() -> None:
    assert len(ENDPOINTS) > 50
    assert ("POST", "/auth/login") in ENDPOINTS
    assert len(MUTATING) > 25


@pytest.mark.parametrize(("method", "path"), PROTECTED)
def test_every_route_needs_a_session(api: ApiContext, method: str, path: str) -> None:  # noqa: F811
    api.client.cookies.clear()

    response = api.client.request(method, _concrete(path), json={})

    assert response.status_code == 401, f"{method} {path} is reachable without a session"


@pytest.mark.parametrize(("method", "path"), MUTATING)
def test_every_state_changing_route_needs_the_csrf_token(
    api: ApiContext,  # noqa: F811
    method: str,
    path: str,
) -> None:
    url = _concrete(path)

    missing = api.client.request(method, url, json={})
    wrong = api.client.request(method, url, json={}, headers={"x-csrf-token": "wrong"})

    assert missing.status_code == 403, f"{method} {path} does not require a CSRF token"
    assert wrong.status_code == 403, f"{method} {path} accepts a wrong CSRF token"
