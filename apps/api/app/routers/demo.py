from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db, require_csrf
from app.pipeline import IncomingMessage, process_message, publish_match_event
from app.routers.notifications import BotNotifierFactory, get_bot_notifier_factory
from models import Recipient, Rule, Source
from packages.events.broker import EventBroker
from packages.rules.dedupe import DedupeCache

router = APIRouter(prefix="/demo", tags=["demo"])


class SimulateMessageRequest(BaseModel):
    """A controlled, test-only message — S3-07's browser demo, not the real listener.

    Real Telegram ingestion stays in `scripts/run_pipeline_demo.py`; this exists so
    the SSE feed and match history can be exercised end to end without a Telegram
    credential.
    """

    source_id: int
    rule_id: int
    recipient_ids: list[int] = Field(min_length=1)
    text: str = Field(min_length=1)
    link: str | None = None


class SimulateMessageResponse(BaseModel):
    match_id: int | None
    reason: str | None
    deliveries_sent: int


def _get_demo_dedupe_cache(request: Request) -> DedupeCache:
    cache: DedupeCache = request.app.state.demo_dedupe_cache
    return cache


def _get_event_broker(request: Request) -> EventBroker:
    broker: EventBroker = request.app.state.event_broker
    return broker


@router.get("", response_class=HTMLResponse, include_in_schema=False)
def demo_page() -> str:
    return _DEMO_PAGE_HTML


@router.post(
    "/messages",
    response_model=SimulateMessageResponse,
    dependencies=[Depends(get_current_session), Depends(require_csrf)],
)
async def simulate_message(
    payload: SimulateMessageRequest,
    db: Session = Depends(get_db),
    notifier_factory: BotNotifierFactory = Depends(get_bot_notifier_factory),
    dedupe_cache: DedupeCache = Depends(_get_demo_dedupe_cache),
    broker: EventBroker = Depends(_get_event_broker),
) -> SimulateMessageResponse:
    source = db.get(Source, payload.source_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "source not found")
    rule = db.get(Rule, payload.rule_id)
    if rule is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "rule not found")

    recipients = list(
        db.scalars(select(Recipient).where(Recipient.id.in_(payload.recipient_ids)))
    )
    if len(recipients) != len(set(payload.recipient_ids)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "recipient not found")

    notifier = notifier_factory({recipient.telegram_chat_id for recipient in recipients})
    message = IncomingMessage(
        source_id=source.id,
        # Synthetic demo input has no Telegram identity. `None` keeps the
        # legacy in-memory dedupe behavior without persisting a fake id.
        message_id=None,
        text=payload.text,
        link=payload.link,
        received_at=datetime.now(UTC),
    )

    result = await process_message(db, message, rule, recipients, notifier, dedupe_cache)
    db.commit()
    publish_match_event(broker, result, db)

    return SimulateMessageResponse(
        match_id=result.match.id if result.match is not None else None,
        reason=result.reason,
        deliveries_sent=result.deliveries_sent,
    )


_DEMO_PAGE_HTML = """<!doctype html>
<html lang="pt-br">
<head><meta charset="utf-8"><title>teleyes — demo S3-07</title></head>
<body>
<h1>teleyes — demo ponta a ponta (S3-07)</h1>
<p>Página de teste, sem estilo — o frontend de verdade é a Sprint 4.</p>

<section>
  <input id="password" type="password" placeholder="senha admin">
  <button id="login">Login</button>
  <span id="login-status"></span>
</section>

<section>
  <button id="load-matches">Carregar histórico (GET /matches)</button>
  <ul id="history"></ul>
</section>

<section>
  <h2>Feed ao vivo (SSE)</h2>
  <ul id="feed"></ul>
</section>

<script>
let csrfToken = null;

document.getElementById("login").onclick = async () => {
  const password = document.getElementById("password").value;
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({password}),
  });
  const statusEl = document.getElementById("login-status");
  if (res.ok) {
    csrfToken = (await res.json()).csrf_token;
    statusEl.textContent = "logado";
    connectToFeed();
  } else {
    statusEl.textContent = "falhou: " + res.status;
  }
};

function connectToFeed() {
  const feed = document.getElementById("feed");
  const source = new EventSource("/events");
  source.addEventListener("match", (event) => {
    const item = document.createElement("li");
    item.textContent = "match ao vivo: " + event.data;
    feed.appendChild(item);
  });
  source.addEventListener("resync", () => {
    const item = document.createElement("li");
    item.textContent = "resync pedido pelo servidor — reconsultando REST";
    feed.appendChild(item);
    loadHistory();
  });
}

async function loadHistory() {
  const res = await fetch("/matches");
  const matches = await res.json();
  const history = document.getElementById("history");
  history.innerHTML = "";
  for (const match of matches) {
    const item = document.createElement("li");
    item.textContent =
      "#" + match.id + " preco_cents=" + match.price_cents + ' texto="' + match.message_text + '"';
    history.appendChild(item);
  }
}

document.getElementById("load-matches").onclick = loadHistory;
</script>
</body>
</html>
"""
