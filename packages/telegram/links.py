from __future__ import annotations

import re

_SUPERGROUP_CHAT_ID_PATTERN = re.compile(r"^-100(\d+)$")


def build_message_link(telegram_chat_id: str, message_id: int) -> str | None:
    """Telegram's own private-link convention for a supergroup/channel
    message (S7-10): `https://t.me/c/<internal id>/<message id>` — mechanical,
    derived from protocol IDs, never parsed or guessed from message text.

    `telegram_chat_id` (`models.Source.telegram_chat_id`) is Telegram's own
    `-100<internal id>` chat id for a supergroup/channel, the common case
    this project targets. Any other shape (a legacy small group's plain
    negative id, a private chat, a malformed value) returns `None` rather
    than inventing a link that would not actually open the message.

    The resulting link only opens for a viewer who already has access to the
    conversation through their own Telegram account — a recipient who isn't
    in the group sees an error page. That's expected Telegram behavior for a
    private group/channel, not a bug here.
    """
    match = _SUPERGROUP_CHAT_ID_PATTERN.match(telegram_chat_id)
    if match is None:
        return None
    return f"https://t.me/c/{match.group(1)}/{message_id}"
