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
