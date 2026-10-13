from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient


async def test_without_token_stays_not_configured_and_never_sends() -> None:
    client = FakeBotClient()
    notifier = BotNotifier(bot_token=None, client=client, allowlisted_chat_ids={"123"})

    result = await notifier.notify(match_id=1, recipient_id=1, chat_id="123", text="Promo!")

    assert result.delivered is False
    assert result.reason == "not_configured"
    assert client.sent == []


async def test_non_allowlisted_chat_id_is_refused() -> None:
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"123"})

    result = await notifier.notify(match_id=1, recipient_id=1, chat_id="999", text="Promo!")

    assert result.delivered is False
    assert result.reason == "not_allowlisted"
    assert client.sent == []


async def test_allowlisted_delivery_succeeds() -> None:
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"123"})

    result = await notifier.notify(match_id=1, recipient_id=1, chat_id="123", text="Promo!")

    assert result.delivered is True
    assert client.sent == [("123", "Promo!")]


async def test_resending_same_match_recipient_pair_does_not_duplicate() -> None:
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"123"})

    first = await notifier.notify(match_id=1, recipient_id=1, chat_id="123", text="Promo!")
    second = await notifier.notify(match_id=1, recipient_id=1, chat_id="123", text="Promo!")

    assert first.delivered is True
    assert second.delivered is False
    assert second.reason == "duplicate"
    assert client.sent == [("123", "Promo!")]


async def test_different_recipient_for_same_match_is_delivered_independently() -> None:
    client = FakeBotClient()
    notifier = BotNotifier(
        bot_token="token", client=client, allowlisted_chat_ids={"123", "456"}
    )

    first = await notifier.notify(match_id=1, recipient_id=1, chat_id="123", text="Promo!")
    second = await notifier.notify(match_id=1, recipient_id=2, chat_id="456", text="Promo!")

    assert first.delivered is True
    assert second.delivered is True
    assert client.sent == [("123", "Promo!"), ("456", "Promo!")]


# ----------------------------------------------------- notify_operational (S13-09)


async def test_operational_alert_without_token_is_a_silent_no_op() -> None:
    client = FakeBotClient()
    notifier = BotNotifier(bot_token=None, client=client, allowlisted_chat_ids={"123"})

    await notifier.notify_operational("⚠️ teleyes: parou de escutar.")

    assert client.sent == []


async def test_operational_alert_reaches_every_allowlisted_recipient() -> None:
    client = FakeBotClient()
    notifier = BotNotifier(
        bot_token="token", client=client, allowlisted_chat_ids={"123", "456"}
    )

    await notifier.notify_operational("⚠️ teleyes: parou de escutar.")

    assert sorted(client.sent) == [
        ("123", "⚠️ teleyes: parou de escutar."),
        ("456", "⚠️ teleyes: parou de escutar."),
    ]


async def test_operational_alert_is_not_affected_by_match_dedupe_state() -> None:
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"123"})

    await notifier.notify(match_id=1, recipient_id=1, chat_id="123", text="Promo!")
    await notifier.notify_operational("⚠️ teleyes: parou de escutar.")
    await notifier.notify_operational("⚠️ teleyes: parou de escutar.")

    assert client.sent == [
        ("123", "Promo!"),
        ("123", "⚠️ teleyes: parou de escutar."),
        ("123", "⚠️ teleyes: parou de escutar."),
    ]
