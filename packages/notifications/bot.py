from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

logger = logging.getLogger(__name__)


class BotClientProtocol(Protocol):
    async def send_message(self, chat_id: str, text: str) -> None: ...


@dataclass
class DeliveryResult:
    delivered: bool
    reason: str | None = None


class BotNotifier:
    """Sends match alerts via a Telegram bot.

    Without `bot_token` the notifier stays `not_configured` and never touches the
    client. Delivery only reaches allowlisted chat ids, and each
    `(match_id, recipient_id)` pair is sent at most once — mirroring the unique
    constraint on `delivery` from S1-02, so a reprocessed match never double-sends.
    """

    def __init__(
        self,
        bot_token: str | None,
        client: BotClientProtocol | None,
        allowlisted_chat_ids: set[str] | None = None,
    ) -> None:
        self._bot_token = bot_token
        self._client = client
        self._allowlisted_chat_ids = allowlisted_chat_ids or set()
        self._delivered: set[tuple[int, int]] = set()

    def set_allowlisted_chat_ids(self, chat_ids: set[str]) -> None:
        """Replace the allowlist as a whole (S13-06: the listener reloads its
        recipients in process). A new set is assigned, never edited in place,
        so a delivery in flight sees either the old or the new list, not a mix.
        The `_delivered` memory is kept: a reload never re-sends anything.
        """
        self._allowlisted_chat_ids = set(chat_ids)

    def is_configured(self) -> bool:
        return bool(self._bot_token)

    async def notify(
        self, match_id: int, recipient_id: int, chat_id: str, text: str
    ) -> DeliveryResult:
        if not self.is_configured():
            return DeliveryResult(delivered=False, reason="not_configured")

        if chat_id not in self._allowlisted_chat_ids:
            return DeliveryResult(delivered=False, reason="not_allowlisted")

        key = (match_id, recipient_id)
        if key in self._delivered:
            return DeliveryResult(delivered=False, reason="duplicate")

        assert self._client is not None, "configured notifier requires a client"
        await self._client.send_message(chat_id, text)
        self._delivered.add(key)
        return DeliveryResult(delivered=True)

    async def notify_operational(self, text: str) -> None:
        """Send one operational alert (S13-09) — not a match — to every
        allowlisted recipient, over the same bot/client as `notify`.

        There is no `(match_id, recipient_id)` dedupe key here: unlike a match
        alert, the caller (`ConnectionSupervisor._block`) is itself the
        one-shot guarantee — this fires once per `blocked` transition, never
        on a reload or a retry. Every current allowlisted chat id receives it;
        there is no separate "admin contact" concept. A `not_configured`
        notifier is a silent no-op, same as `notify`.
        """
        if not self.is_configured():
            return
        assert self._client is not None, "configured notifier requires a client"
        for chat_id in self._allowlisted_chat_ids:
            await self._client.send_message(chat_id, text)
