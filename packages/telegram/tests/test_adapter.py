from packages.telegram.adapter import AdapterState, TelegramAdapter
from packages.telegram.fakes import FakeTelegramClient


async def fake_sleep(seconds: float) -> None:
    return None


async def test_without_credentials_stays_not_configured_and_skips_client() -> None:
    client = FakeTelegramClient()
    adapter = TelegramAdapter(api_id=None, api_hash=None, client=client, sleep=fake_sleep)

    state = await adapter.connect()

    assert state is AdapterState.NOT_CONFIGURED
    assert adapter.state is AdapterState.NOT_CONFIGURED
    assert client.connect_calls == 0


async def test_connect_succeeds_with_configured_client() -> None:
    client = FakeTelegramClient(script=[None])
    adapter = TelegramAdapter(api_id=1, api_hash="hash", client=client, sleep=fake_sleep)

    state = await adapter.connect()

    assert state is AdapterState.CONNECTED
    assert client.connect_calls == 1


async def test_reconnect_backs_off_exponentially_then_reaches_blocked() -> None:
    client = FakeTelegramClient(script=[None, 1.0, 1.0, "blocked"])
    adapter = TelegramAdapter(
        api_id=1,
        api_hash="hash",
        client=client,
        sleep=fake_sleep,
        base_backoff_seconds=1.0,
        max_backoff_seconds=60.0,
    )

    connected_state = await adapter.connect()
    assert connected_state is AdapterState.CONNECTED

    await adapter.disconnect()
    assert adapter.state is AdapterState.RECONNECTING

    final_state = await adapter.reconnect()

    assert final_state is AdapterState.BLOCKED
    assert adapter.backoff_delays == [1.0, 2.0]
    assert client.connect_calls == 4
    assert client.disconnect_calls == 1


async def test_exhausting_attempts_without_block_signal_ends_blocked() -> None:
    client = FakeTelegramClient(script=[0.1, 0.1])
    adapter = TelegramAdapter(
        api_id=1,
        api_hash="hash",
        client=client,
        sleep=fake_sleep,
        max_attempts=2,
        base_backoff_seconds=0.1,
    )

    state = await adapter.connect()

    assert state is AdapterState.BLOCKED
    assert client.connect_calls == 2
