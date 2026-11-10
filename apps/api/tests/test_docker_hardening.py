"""S23-01: the container hardening is configuration, so it is checked as configuration.

A real boot proves more (docs/SECURITY_AUDIT.md says how it was done), but these catch
the regressions that matter: an entrypoint that forgets to drop root, an image that stops
creating the user, a compose file that loses `no-new-privileges`.
"""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
DOCKER = ROOT / "docker"
ENTRYPOINTS = ["api", "listener", "backup", "demo"]
COMPOSE_FILES = ["docker-compose.yml", "docker-compose.prod.yml"]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


@pytest.mark.parametrize("name", ENTRYPOINTS)
def test_every_entrypoint_drops_root_before_doing_anything(name: str) -> None:
    lines = [
        line
        for line in _read(DOCKER / f"{name}-entrypoint.sh").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]

    # `set -e`, then the privilege drop, then everything else.
    assert lines[0] == "set -e"
    assert lines[1] == '[ "$(id -u)" = "0" ] && exec /as-teleyes.sh "$0" "$@"'


def test_the_helper_hands_the_volumes_over_and_drops_to_the_service_user() -> None:
    script = _read(DOCKER / "as-teleyes.sh")

    assert "chown teleyes:teleyes" in script
    assert "setpriv --reuid=teleyes --regid=teleyes --clear-groups" in script
    assert "/app/data" in script and "/app/session" in script and "/app/backups" in script


def test_the_api_image_has_the_unprivileged_user_and_the_helper() -> None:
    dockerfile = _read(DOCKER / "api.Dockerfile")

    assert re.search(r"useradd .*--uid 10001 .*\bteleyes\b", dockerfile)
    assert "COPY docker/as-teleyes.sh /as-teleyes.sh" in dockerfile
    assert "/as-teleyes.sh" in re.search(r"RUN chmod \+x .*", dockerfile).group(0)  # type: ignore[union-attr]


def test_the_web_image_is_the_unprivileged_nginx_on_a_high_port() -> None:
    dockerfile = _read(DOCKER / "web.Dockerfile")
    nginx = _read(DOCKER / "web-nginx.conf")

    assert "nginx-unprivileged" in dockerfile
    # `USER root` is only for `apk upgrade`; the image must end back on uid 101.
    users = re.findall(r"^USER (\S+)$", dockerfile, re.MULTILINE)
    assert users[-1] == "101"
    assert re.search(r"listen 8080;", nginx)


@pytest.mark.parametrize("name", COMPOSE_FILES)
def test_compose_stacks_forbid_privilege_escalation_and_publish_only_to_localhost(
    name: str,
) -> None:
    compose = _read(ROOT / name)

    assert "no-new-privileges:true" in compose
    published = re.findall(r'^\s+- "([^"]+:8080)"\s*$', compose, re.MULTILINE)
    assert published, "the web port is expected to be published"
    assert all(entry.startswith("127.0.0.1:") for entry in published)
