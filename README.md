# teleyes

Monitor pessoal de promoções do Telegram. O teleyes acompanha grupos acessíveis pela conta configurada,
aplica regras de palavras-chave, preço, fontes e bloqueios, remove duplicatas e envia alertas por um bot
privado do Telegram. Um painel web responsivo mostra resultados e saúde do serviço em tempo real.

O projeto está na Sprint 0 de alinhamento. A especificação está em `docs/PROJECT_SPEC.md` e o contexto de
produto do frontend em `PRODUCT.md`.

## Stack planejada

- Python, FastAPI e Telethon
- React, Vite e TypeScript
- SQLite em modo WAL
- Server-Sent Events para atualização do feed
- Docker Compose para execução 24/7
- Tailscale Serve para acesso remoto privado

Nenhuma credencial ou sessão do Telegram deve ser versionada.

## Contrato da API

`contracts/openapi.json` e `contracts/api-types.ts` são gerados a partir do schema OpenAPI que o FastAPI
já expõe em `GET /openapi.json` — ainda sem app frontend, servem como o contrato tipado que a Sprint 4 vai
consumir. Para regenerar depois de mudar uma rota:

```bash
source .venv/bin/activate
./scripts/generate_ts_client.sh
```

O teste `apps/api/tests/test_openapi_contract.py::test_committed_contract_file_matches_the_live_schema`
falha se `contracts/openapi.json` ficar desatualizado em relação ao schema real.
