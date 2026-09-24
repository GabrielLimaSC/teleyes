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

    def delivery_block_reason(self, chat_id: str) -> str | None:
        """Return a reason only when no external send can possibly start.

        Digest delivery uses this synchronous preflight before reserving queue
        rows. A known local condition may safely remain pending; once the
        client call starts, its outcome is potentially ambiguous and must not
        be retried merely because the process did not record a response.
        """
        if not self.is_configured():
            return "not_configured"
        if chat_id not in self._allowlisted_chat_ids:
            return "not_allowlisted"
        return None

    async def notify(
        self, match_id: int, recipient_id: int, chat_id: str, text: str
    ) -> DeliveryResult:
        block_reason = self.delivery_block_reason(chat_id)
        if block_reason is not None:
            return DeliveryResult(delivered=False, reason=block_reason)

        key = (match_id, recipient_id)
        if key in self._delivered:
            return DeliveryResult(delivered=False, reason="duplicate")

        assert self._client is not None, "configured notifier requires a client"
        await self._client.send_message(chat_id, text)
        self._delivered.add(key)
        return DeliveryResult(delivered=True)

    async def notify_digest(self, chat_id: str, text: str) -> DeliveryResult:
        """Sends one digest message (S14-04) — many matches folded into a
        single text, so it does not fit `notify`'s per-`(match_id,
        recipient_id)` dedupe key at all. Idempotency for a digest lives in
        the database instead: `digest_run` gates the local date and each
        selected `Delivery` is durably `digest_attempted` before this method
        starts an external call. This therefore never touches `_delivered`.
        """
        block_reason = self.delivery_block_reason(chat_id)
        if block_reason is not None:
            return DeliveryResult(delivered=False, reason=block_reason)

        assert self._client is not None, "configured notifier requires a client"
        await self._client.send_message(chat_id, text)
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
