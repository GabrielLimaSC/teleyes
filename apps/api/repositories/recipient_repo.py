from collections.abc import Collection, Sequence

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.recipient_rules import RULES_MODES, load_selected_rule_ids
from models import Recipient, RecipientRule, Rule
from models.recipient import RULES_MODE_SELECTED
from repositories.errors import InvalidSettingsError, NotFoundError, ValidationError


def validate_delivery_settings(
    session: Session,
    *,
    rules_mode: str,
    rule_ids: Collection[int],
    notify_target: bool,
    notify_common: bool,
) -> None:
    """S21-06 (F8). Messages are shown to the person using the panel (pt-BR)."""
    if rules_mode not in RULES_MODES:
        raise InvalidSettingsError("Modo de regras inválido: use 'all' ou 'selected'.")
    wanted = set(rule_ids)
    existing = set(session.scalars(select(Rule.id).where(Rule.id.in_(wanted))))
    missing = sorted(wanted - existing)
    if missing:
        raise InvalidSettingsError(f"Regra inexistente: {', '.join(map(str, missing))}.")
    if rules_mode == RULES_MODE_SELECTED:
        if not wanted:
            raise InvalidSettingsError("Escolha pelo menos uma regra para este destinatário.")
        if not (notify_target or notify_common):
            raise InvalidSettingsError("Ligue pelo menos um tipo de alerta.")


def get_rule_ids(session: Session, recipient_id: int) -> list[int]:
    return sorted(
        session.scalars(
            select(RecipientRule.rule_id).where(RecipientRule.recipient_id == recipient_id)
        )
    )


def rule_ids_by_recipient(session: Session) -> dict[int, list[int]]:
    return {rid: sorted(ids) for rid, ids in load_selected_rule_ids(session).items()}


def _replace_rule_ids(session: Session, recipient_id: int, rule_ids: Collection[int]) -> None:
    session.execute(delete(RecipientRule).where(RecipientRule.recipient_id == recipient_id))
    session.add_all(
        RecipientRule(recipient_id=recipient_id, rule_id=rule_id) for rule_id in set(rule_ids)
    )


def _find_by_chat_id(session: Session, telegram_chat_id: str) -> Recipient | None:
    return session.scalar(
        select(Recipient).where(Recipient.telegram_chat_id == telegram_chat_id)
    )


def create_recipient(
    session: Session,
    *,
    name: str,
    telegram_chat_id: str,
    allowlisted: bool = False,
    rules_mode: str = "all",
    rule_ids: Collection[int] = (),
    notify_target: bool = True,
    notify_common: bool = True,
) -> Recipient:
    if _find_by_chat_id(session, telegram_chat_id) is not None:
        raise ValidationError(
            f"recipient with telegram_chat_id {telegram_chat_id} already exists"
        )
    validate_delivery_settings(
        session,
        rules_mode=rules_mode,
        rule_ids=rule_ids,
        notify_target=notify_target,
        notify_common=notify_common,
    )

    recipient = Recipient(
        name=name,
        telegram_chat_id=telegram_chat_id,
        allowlisted=allowlisted,
        rules_mode=rules_mode,
        notify_target=notify_target,
        notify_common=notify_common,
    )
    session.add(recipient)
    session.flush()
    _replace_rule_ids(session, recipient.id, rule_ids)
    session.flush()
    return recipient


def list_recipients(session: Session, *, include_inactive: bool = False) -> Sequence[Recipient]:
    stmt = select(Recipient)
    if not include_inactive:
        stmt = stmt.where(Recipient.active.is_(True))
    return session.scalars(stmt).all()


def _get_recipient(session: Session, recipient_id: int) -> Recipient:
    recipient = session.get(Recipient, recipient_id)
    if recipient is None:
        raise NotFoundError(f"recipient {recipient_id} not found")
    return recipient


def update_recipient(
    session: Session,
    recipient_id: int,
    *,
    name: str | None = None,
    telegram_chat_id: str | None = None,
    allowlisted: bool | None = None,
    rules_mode: str | None = None,
    rule_ids: Collection[int] | None = None,
    notify_target: bool | None = None,
    notify_common: bool | None = None,
) -> Recipient:
    recipient = _get_recipient(session, recipient_id)

    if telegram_chat_id is not None and telegram_chat_id != recipient.telegram_chat_id:
        existing = _find_by_chat_id(session, telegram_chat_id)
        if existing is not None:
            raise ValidationError(
                f"recipient with telegram_chat_id {telegram_chat_id} already exists"
            )

    touches_delivery = any(
        value is not None for value in (rules_mode, rule_ids, notify_target, notify_common)
    )
    if touches_delivery:
        # Validate the resulting state (not only the sent fields) before any
        # write, so a rejected change leaves the recipient untouched. A PATCH
        # that sends none of these fields is never blocked by them.
        new_mode = rules_mode if rules_mode is not None else recipient.rules_mode
        new_rule_ids = rule_ids if rule_ids is not None else get_rule_ids(session, recipient_id)
        new_target = notify_target if notify_target is not None else recipient.notify_target
        new_common = notify_common if notify_common is not None else recipient.notify_common
        validate_delivery_settings(
            session,
            rules_mode=new_mode,
            rule_ids=new_rule_ids,
            notify_target=new_target,
            notify_common=new_common,
        )
        recipient.rules_mode = new_mode
        recipient.notify_target = new_target
        recipient.notify_common = new_common
        if rule_ids is not None:
            _replace_rule_ids(session, recipient_id, rule_ids)

    if telegram_chat_id is not None:
        recipient.telegram_chat_id = telegram_chat_id
    if name is not None:
        recipient.name = name
    if allowlisted is not None:
        recipient.allowlisted = allowlisted

    session.flush()
    return recipient


def pause_recipient(session: Session, recipient_id: int) -> Recipient:
    recipient = _get_recipient(session, recipient_id)
    recipient.active = False
    session.flush()
    return recipient


def delete_recipient(session: Session, recipient_id: int) -> None:
    recipient = _get_recipient(session, recipient_id)
    session.execute(delete(RecipientRule).where(RecipientRule.recipient_id == recipient_id))
    session.delete(recipient)
    session.flush()
