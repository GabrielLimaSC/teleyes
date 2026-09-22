import json
from pathlib import Path
from typing import Any

from app.main import app

CONTRACT_PATH = Path(__file__).resolve().parents[3] / "contracts" / "openapi.json"

# Every route the API exposes today, with the HTTP methods each one accepts.
EXPECTED_PATHS: dict[str, set[str]] = {
    "/auth/login": {"post"},
    "/auth/me": {"get"},
    "/auth/logout": {"post"},
    "/health": {"get"},
    "/rules": {"get", "post"},
    "/rules/test": {"post"},
    "/rules/{rule_id}": {"patch", "delete"},
    "/rules/{rule_id}/pause": {"post"},
    "/rules/{rule_id}/matches": {"delete"},
    "/sources": {"get", "post"},
    "/sources/{source_id}": {"patch", "delete"},
    "/sources/{source_id}/pause": {"post"},
    "/recipients": {"get", "post"},
    "/recipients/{recipient_id}": {"patch", "delete"},
    "/recipients/{recipient_id}/pause": {"post"},
    "/matches": {"get"},
    "/metrics": {"get"},
    "/notifications/test": {"post"},
    "/events": {"get"},
    "/listener/status": {"get"},
    "/listener/reload": {"post"},
    "/demo/messages": {"post"},
}

EXPECTED_RESPONSE_SCHEMAS = [
    "RuleResponse",
    "RuleTestResponse",
    "SourceResponse",
    "RecipientResponse",
    "MatchResponse",
    "DeliveryResponse",
    "HealthResponse",
    "MetricResponse",
    "TestNotificationResponse",
    "SimulateMessageResponse",
    "ListenerStatusResponse",
]


def _schema() -> dict[str, Any]:
    return app.openapi()


def test_openapi_schema_exposes_every_route_with_its_methods() -> None:
    paths = _schema()["paths"]

    assert set(paths.keys()) == set(EXPECTED_PATHS.keys())
    for path, expected_methods in EXPECTED_PATHS.items():
        assert set(paths[path].keys()) == expected_methods, f"unexpected methods for {path}"


def test_openapi_schema_types_every_response_model_as_an_object() -> None:
    components = _schema()["components"]["schemas"]

    for name in EXPECTED_RESPONSE_SCHEMAS:
        assert name in components, f"missing schema: {name}"
        assert components[name]["type"] == "object"


def test_committed_contract_file_matches_the_live_schema() -> None:
    """Guards against `contracts/openapi.json` drifting from the real API.

    Regenerate it with `scripts/generate_ts_client.sh` (or
    `scripts/export_openapi.py`) whenever a route changes.
    """
    assert CONTRACT_PATH.exists(), "run scripts/export_openapi.py to create it"
    committed = json.loads(CONTRACT_PATH.read_text())

    assert committed == _schema()
