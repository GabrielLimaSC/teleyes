# Sprint 0 — Parecer técnico (Tech Lead)

Referência: `docs/PROJECT_SPEC.md`, `PRODUCT.md`, `CLAUDE.md`, `TASKS.md`. Registrado em 2026-09-11.

## 1. Decisões confirmadas (não reabrir sem evidência nova)

- Processo único, SQLite em WAL e SSE para tempo real. Sem Redis/Postgres/Kafka/Celery/microserviços.
- Stack: Python + FastAPI + Telethon + SQLAlchemy 2 + Alembic; React + Vite + TypeScript no frontend.
- Retenção de conteúdo somente para mensagens que casaram com regra; descartes só geram métricas agregadas.
- Gabriel é único admin/login do painel; namorada é destinatária sem login na v1.
- Acesso remoto exclusivamente via Tailscale Serve; serviço escuta apenas em localhost.
- Sessão MTProto do usuário separada do bot notifier; bot nunca lê grupos.
- Extração de preço conservadora primeiro; regex/fuzzy só com casos reais.

## 2. Decisões técnicas delegadas ao Tech Lead (fechadas nesta revisão)

| Tema | Decisão | Motivo |
|---|---|---|
| Versão Python | 3.12 (imagem Docker) | Disponível localmente via Homebrew; compatível com SQLAlchemy 2/FastAPI atuais. |
| Lint/type check | Ruff + mypy | Ruff cobre lint+format rápido; mypy é mais maduro que pyright para SQLAlchemy 2 typing. |
| Testes backend | pytest + fixtures fake para Telethon/Bot API | Permite testar lógica sem credenciais reais. |
| Testes frontend | Vitest (unit) + Playwright (e2e) | Já fixado no CLAUDE.md; sem alternativa avaliada. |
| Estrutura de pastas | `apps/api`, `apps/web`, `packages/telegram`, `packages/rules`, `packages/notifications`, `data/` | Conforme `docs/PROJECT_SPEC.md` §6, sem alteração. |
| Secrets locais | `.env` (fora do Git) + `.env.example` versionado; sem vault externo na v1 | Escopo pessoal, single-tenant; vault externo é escala prematura. |
| IDs de task/branch | `S<sprint>-<seq>`, branch `feature/<task-id>` | Já convencionado em `AGENTS.md`. |

## 3. Riscos adicionais identificados

1. **Concorrência de escrita no SQLite** — o listener Telethon (assíncrono) e a API podem escrever
   simultaneamente. Mitigação: um único processo/writer para persistência (fila interna ou lock por
   sessão), leitura pode ser concorrente. Validar em teste de carga leve na Sprint 1.
2. **Perda do arquivo de sessão Telethon** — equivale a perder o login da conta. Mitigação: backup do
   volume de sessão fora do Git, procedimento de restauração documentado antes da Sprint 5.
3. **Duplicação de alerta entre persistência e envio** — crash entre gravar o match e confirmar entrega
   pode reenviar. Mitigação: constraint única `(match_id, recipient_id)` na tabela de delivery e
   idempotência na task S1-05.
4. **Ambiguidade de formato de preço pt-BR** — `R$ 1.234,56` vs `1234.56` vs parcelamento. Mitigação:
   parser conservador documentado, mensagens ambíguas seguem a política "sem preço" da regra (Sprint 2).
5. **Rate limit / flood wait do Telegram** (MTProto e Bot API) — sem tratamento pode bloquear a conta.
   Mitigação: backoff exponencial no adapter (Sprint 1/2), nunca retry imediato.
6. **SO do desktop final indefinido** — bloqueia apenas boot automático, prevenção de suspensão e runbook
   de energia (Sprint 5). Não bloqueia Sprints 1–4.

## 4. Portões humanos e o que eles bloqueiam de fato

| Portão | Bloqueia | Não bloqueia |
|---|---|---|
| `TG_API_ID`/`TG_API_HASH` + login/2FA | Teste de integração real (S1-06) | Scaffold, schema, adapter com fake client, matching, dedupe (S1-01 a S1-05) |
| Token BotFather + chat IDs | Envio real de alerta (S1-06) | Notifier com fake bot client e idempotência (S1-05) |
| SO do desktop de produção | Boot automático, prevenção de suspensão (Sprint 5) | Sprints 1–4 |
| Instalação/login Tailscale | Acesso remoto real (Sprint 5) | Sprints 1–4 |
| Escolha do mockup (Gabriel) | Implementação visual definitiva (Sprint 4, parte final) | Conceitos/comps do Codex Design |

## 5. Ambiente validado (S0-03)

- Docker 28.5.2 disponível.
- GitHub CLI autenticado como `GabrielLimaSC`, escopos `repo`/`read:org`/`gist`.
- Python 3.12 disponível via Homebrew para uso local fora do container (Docker usa imagem `python:3.12`).
- Tailscale **não instalado** nesta máquina — pendente, sem impacto até a Sprint 5.
- SO final do desktop doméstico **não confirmado** — pendente, sem impacto até a Sprint 5.

## 6. Conclusão

Nenhum bloqueio impede o início da Sprint 1. As tasks S1-01 a S1-05 não dependem de credencial alguma.
Sprint 0 encerrada; Sprint 1 aberta em `TASKS.md`.
