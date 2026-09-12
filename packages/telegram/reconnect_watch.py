from __future__ import annotations

from collections.abc import Awaitable, Callable

from packages.telegram.adapter import SleepFn

IsConnectedFn = Callable[[], bool]
OnReconnectFn = Callable[[], Awaitable[None]]


async def supervise_reconnects(
    is_connected: IsConnectedFn,
    on_reconnect: OnReconnectFn,
    *,
    poll_seconds: float,
    sleep: SleepFn,
    iterations: int | None = None,
) -> None:
    """Call `on_reconnect` exactly once each time `is_connected()` flips back
    to `True` after being `False` — the one signal a real Telethon client's
    own auto-reconnect (default `auto_reconnect=True`) doesn't expose or act
    on for us: reading the installed telethon client's own source
    (`client/updates.py::_handle_auto_reconnect`), its real catch-up branch
    sits dead behind an unconditional early `return`, so a short connection
    drop that Telethon silently recovers from is otherwise invisible to our
    code, and any message that arrived during the gap is lost rather than
    recovered by `app.pipeline.catch_up_since_cursor`.

    Polling a client's public `is_connected()` is the only hook available for
    this without depending on Telethon internals — a real drop is noticed
    with up to `poll_seconds` of latency, and one that self-heals within a
    single poll interval is missed entirely (accepted, explicit tradeoff, not
    a silent one). Runs forever unless `iterations` bounds it, which exists
    only so a test can stop this without needing to cancel a task.
    """
    was_connected = is_connected()
    count = 0
    while iterations is None or count < iterations:
        await sleep(poll_seconds)
        connected_now = is_connected()
        if connected_now and not was_connected:
            await on_reconnect()
        was_connected = connected_now
        count += 1
