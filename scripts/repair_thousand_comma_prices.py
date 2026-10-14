"""Repara precos antigos lidos errado por causa da virgula de milhar (S17-07).

Antes da S14-11, o parser lia `6,991` como R$ 6,99 (virgula + 2 digitos) e
descartava o ultimo digito. O parser atual le R$ 6.991,00. Este script
reextrai o preco do `message_text` salvo com o parser ATUAL e corrige so os
registros comprovadamente afetados.

Uso (dentro do container/ambiente do app, com DATABASE_URL apontando pro banco):
    python scripts/repair_thousand_comma_prices.py                  # dry-run (padrao)
    python scripts/repair_thousand_comma_prices.py --apply --confirm-backup

Heuristica (conservadora). Um campo de preco gravado S diverge do preco novo N
e e considerado "afetado" somente se TODAS as condicoes valem:
  1. o texto da mensagem contem um token de virgula de milhar (`6,991`,
     `1,007`, `7,070`);
  2. S nao e nulo e N nao e nulo;
  3. S bate com o erro do parser antigo: `S == (N // 100) // 10` (o parser
     antigo leu `A,BC` em vez de `A,BCD`), ou N == S * 10, S * 100 ou S * 1000.
Um registro so e corrigido se TODOS os campos divergentes (price_cents,
price_cash_cents, price_card_cents) forem afetados. Qualquer outra divergencia
vai pra "revisar manualmente" (so ids). Registros com price_source == 'manual'
nunca sao tocados. Mexe so nos campos de preco (e em original_price_cents
quando price_source == 'parsed' e ele guarda o mesmo valor errado); precos
derivados (historico, menor preco, agrupamento) sao calculados em consulta a
partir de Match, entao nao ha nada a recalcular.

Saida: somente ids e valores; nunca texto de mensagem nem link.
"""

import argparse
import re
import sys
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Match
from models.db import get_engine, get_sessionmaker
from packages.rules.price import extract_price

_COMMA_THOUSANDS_TOKEN_RE = re.compile(r"\d{1,3}(?:,\d{3})+(?!\d)(?!,\d)")
_PRICE_FIELDS = ("price_cents", "price_cash_cents", "price_card_cents")


@dataclass
class Report:
    analyzed: int = 0
    no_price: int = 0
    manual_skipped: int = 0
    divergent: list[tuple[int, dict[str, tuple[int | None, int | None]]]] = field(
        default_factory=list
    )
    affected_ids: list[int] = field(default_factory=list)
    review_ids: list[int] = field(default_factory=list)
    applied: int = 0


def format_brl(cents: int | None) -> str:
    if cents is None:
        return "sem preço"
    reais, rest = divmod(cents, 100)
    return f"R$ {reais:,}".replace(",", ".") + f",{rest:02d}"


def _is_old_parser_error(stored: int | None, new: int | None) -> bool:
    if stored is None or new is None or stored <= 0:
        return False
    if stored == (new // 100) // 10:
        return True
    return new in (stored * 10, stored * 100, stored * 1000)


def _new_values(text: str) -> dict[str, int | None]:
    extraction = extract_price(text)
    return {
        "price_cents": extraction.price_cents,
        "price_cash_cents": extraction.price_cash_cents,
        "price_card_cents": extraction.price_card_cents,
    }


def repair_prices(session: Session, *, apply: bool) -> Report:
    report = Report()
    for match in session.scalars(select(Match).order_by(Match.id)):
        report.analyzed += 1
        new = _new_values(match.message_text)
        if all(v is None for v in new.values()) and all(
            getattr(match, f) is None for f in _PRICE_FIELDS
        ):
            report.no_price += 1
            continue
        diffs = {
            f: (getattr(match, f), new[f]) for f in _PRICE_FIELDS if getattr(match, f) != new[f]
        }
        if not diffs:
            continue
        if match.price_source == "manual":
            report.manual_skipped += 1
            continue
        report.divergent.append((match.id, diffs))
        proven = bool(_COMMA_THOUSANDS_TOKEN_RE.search(match.message_text)) and all(
            _is_old_parser_error(old, fixed) for old, fixed in diffs.values()
        )
        if not proven:
            report.review_ids.append(match.id)
            continue
        report.affected_ids.append(match.id)
        if apply:
            old_main = match.price_cents
            for f, (_, fixed) in diffs.items():
                setattr(match, f, fixed)
            if match.price_source == "parsed" and match.original_price_cents == old_main:
                match.original_price_cents = match.price_cents
            report.applied += 1
    if apply:
        session.commit()
    return report


def print_report(report: Report, *, apply: bool) -> None:
    mode = "APPLY" if apply else "DRY-RUN"
    print(f"[{mode}] Reparo de preços com vírgula de milhar")
    for match_id, diffs in report.divergent:
        for name, (old, fixed) in diffs.items():
            tag = "corrigir" if match_id in report.affected_ids else "revisar"
            print(f"  id={match_id} {name}: {format_brl(old)} -> {format_brl(fixed)} [{tag}]")
    print(f"Analisados: {report.analyzed}")
    print(f"Sem preço: {report.no_price}")
    print(f"Divergentes (não manuais): {len(report.divergent)}")
    print(f"Preço manual ignorado (divergente, não tocado): {report.manual_skipped}")
    print(f"Comprovadamente afetados: {len(report.affected_ids)} ids={report.affected_ids}")
    if report.review_ids:
        print(f"Revisar manualmente: {len(report.review_ids)} ids={report.review_ids}")
    if apply:
        print(f"Atualizados: {report.applied}")
    else:
        print("Nada foi gravado (dry-run). Use --apply --confirm-backup para gravar.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="grava as correções")
    parser.add_argument(
        "--confirm-backup",
        action="store_true",
        help="confirma que há backup recente do banco (obrigatório com --apply)",
    )
    args = parser.parse_args(argv)

    if args.apply and not args.confirm_backup:
        print("Recusado: --apply exige --confirm-backup (faça o backup antes).", file=sys.stderr)
        return 2

    engine = get_engine()
    with get_sessionmaker(engine)() as session:
        report = repair_prices(session, apply=args.apply)
    print_report(report, apply=args.apply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
