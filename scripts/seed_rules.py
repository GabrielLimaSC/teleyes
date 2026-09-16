"""Semeia as regras padrão da wishlist de hardware do Gabriel (S9-07).

Uso:
    python scripts/seed_rules.py

Idempotente: roda em qualquer momento sem duplicar regras já existentes
(checa por nome). Pensado pra homologação do zero, que este projeto já
perdeu e refez mais de uma vez (ver S6-03) — em vez de recriar as regras na
mão pelo painel toda vez que o banco é zerado, este script faz de uma vez
só.

A wishlist (Gabriel, `Features and Fix.pdf`, item 7) lista 5 componentes,
mas a placa de vídeo vira 2 regras — RTX 5070 12GB e RTX 5070 Ti são opções
alternativas pro Gabriel, não a mesma peça — totalizando 6 regras. Nenhuma
tem `max_price_cents`: Gabriel não deu teto de preço, só o modelo desejado.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Rule
from models.db import get_engine, get_sessionmaker
from repositories.rule_repo import create_rule

# (nome, include_terms, exclude_terms) — `packages/rules/match.py` casa por
# substring normalizada (sem acento/pontuação, minúscula), sem exigir
# combinação "E" entre termos: cada entrada de `include_terms` é uma
# alternativa "OU" independente, pensada pra cobrir fraseado real comum sem
# ficar tão genérica que vire ruído (ver a task S9-07 sobre "Fonte" sozinho).
DEFAULT_RULES: list[tuple[str, str, str | None]] = [
    (
        "RTX 5070 12GB",
        "rtx 5070 12gb,rtx 5070",
        # "rtx 5070" sozinho também bateria num anúncio da Ti — exclui pra
        # não notificar as duas regras pra uma mensagem só da Ti.
        "5070 ti",
    ),
    (
        "RTX 5070 Ti",
        "rtx 5070 ti,5070 ti",
        None,
    ),
    (
        "Ryzen 7 9800X3D",
        "ryzen 7 9800x3d,9800x3d",
        None,
    ),
    (
        "Placa-mãe AM5/B850",
        # Gabriel: B850 ou qualquer AM5 que suporte o 9800X3D + RAM DDR5 —
        # o soquete AM5 só existe com DDR5 (ao contrário do AM4, que é
        # DDR4), então listar os chipsets AM5 já cobre o pedido sem
        # precisar checar RAM separadamente.
        "b850,x870e,x870,b650e,b650,a620,am5",
        None,
    ),
    (
        "Fonte Cooler Master MWE Gold 750 V3",
        # "Fonte" sozinho é genérico demais (o próprio Gabriel citou como
        # exemplo do que evitar) — precisa do termo do modelo.
        "cooler master mwe gold 750,mwe gold 750",
        None,
    ),
    (
        "RAM DDR5 16GB",
        # Gabriel aceita as duas formas (kit único de 16GB ou par de 8GB) —
        # cobre as ordens de fraseado mais comuns em anúncio real.
        "ddr5 16gb,16gb ddr5,2x8gb ddr5,8gb ddr5",
        None,
    ),
]


def seed_default_rules(session: Session) -> dict[str, str]:
    """Creates every rule in `DEFAULT_RULES` that doesn't already exist,
    matched by name. Returns `{name: "criada" | "já existia"}` for the
    caller to report. Never updates an existing rule's terms — a real edit
    made later through the panel is never silently overwritten by a re-run,
    same "create or leave alone" idempotency as `create_admin.py`'s
    "create or reset" (different verb, same one-row-per-name guarantee).
    """
    existing_names = set(session.scalars(select(Rule.name)).all())
    results: dict[str, str] = {}
    for name, include_terms, exclude_terms in DEFAULT_RULES:
        if name in existing_names:
            results[name] = "já existia"
            continue
        create_rule(session, name=name, include_terms=include_terms, exclude_terms=exclude_terms)
        results[name] = "criada"
    return results


def main() -> None:
    session_factory = get_sessionmaker(get_engine())
    with session_factory() as session:
        results = seed_default_rules(session)
        session.commit()

    for name, action in results.items():
        print(f"{name}: {action}")


if __name__ == "__main__":
    main()
