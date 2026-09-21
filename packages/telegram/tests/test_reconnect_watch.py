from packages.telegram.reconnect_watch import supervise_reconnects


async def _fake_sleep(seconds: float) -> None:
    return None


async def test_calls_on_reconnect_exactly_once_per_false_to_true_transition() -> None:
    # Connected the whole time except for one drop between polls 2 and 4.
    states = iter([True, True, True, False, False, True, True])
    reconnects = 0

    async def on_reconnect() -> None:
        nonlocal reconnects
        reconnects += 1

    await supervise_reconnects(
        lambda: next(states),
        on_reconnect,
        poll_seconds=0,
        sleep=_fake_sleep,
        iterations=6,
    )

    assert reconnects == 1


async def test_never_connected_never_calls_on_reconnect() -> None:
    async def on_reconnect() -> None:
        raise AssertionError("must not be called")

    await supervise_reconnects(
        lambda: False,
        on_reconnect,
        poll_seconds=0,
        sleep=_fake_sleep,
        iterations=5,
    )


async def test_a_glitch_that_self_heals_within_one_poll_is_missed() -> None:
    # is_connected() is only sampled once per poll interval — a drop and
    # recovery that both happen between two samples never shows up as a
    # False observation at all, so on_reconnect correctly never fires. This
    # is the documented, accepted tradeoff of polling a public flag rather
    # than hooking Telethon's own (unexposed, in this version dead-code)
    # reconnect internals.
    states = iter([True, True, True])
    reconnects = 0

    async def on_reconnect() -> None:
        nonlocal reconnects
        reconnects += 1

    await supervise_reconnects(
        lambda: next(states),
        on_reconnect,
        poll_seconds=0,
        sleep=_fake_sleep,
        iterations=2,
    )

    assert reconnects == 0


async def test_a_failing_catch_up_does_not_kill_the_watchdog_and_is_retried() -> None:
    # S13-02: the link often drops again *during* the catch-up right after a
    # reconnect. That ConnectionError used to escape the watchdog task and end
    # all future gap recovery silently.
    states = iter([True, False, True, True, True, True])
    attempts = 0

    async def flaky_catch_up() -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise ConnectionError("Connection to Telegram failed 5 time(s)")

    await supervise_reconnects(
        lambda: next(states),
        flaky_catch_up,
        poll_seconds=0,
        sleep=_fake_sleep,
        iterations=5,
    )

    assert attempts == 2  # failed once, retried on the next poll, then not repeated
