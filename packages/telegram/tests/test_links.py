from packages.telegram.links import build_message_link


def test_builds_the_real_telegram_link_for_a_supergroup_chat_id() -> None:
    assert build_message_link("-1001234567890", 42) == "https://t.me/c/1234567890/42"


def test_returns_none_for_a_legacy_small_group_chat_id() -> None:
    # Plain negative id, no -100 prefix — not a supergroup/channel.
    assert build_message_link("-123456", 42) is None


def test_returns_none_for_a_private_chat_positive_id() -> None:
    assert build_message_link("123456", 42) is None


def test_returns_none_for_a_malformed_chat_id() -> None:
    assert build_message_link("not-a-chat-id", 42) is None


def test_returns_none_for_only_the_prefix_with_no_digits() -> None:
    assert build_message_link("-100", 42) is None
