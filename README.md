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

## Backup e restauração

O serviço `backup` (`docker-compose.prod.yml`) roda em segundo plano a cada `BACKUP_INTERVAL_SECONDS`
(padrão: 6h), produzindo um snapshot consistente do SQLite via `VACUUM INTO` — seguro mesmo com `api` e
`listener` escrevendo no banco ao mesmo tempo, sem precisar parar nada. Mantém as últimas
`BACKUP_RETENTION_COUNT` cópias (padrão: 28, ~7 dias) no volume nomeado `teleyes-backups`, apagando o
resto automaticamente. Lógica de backup/retenção em `packages/backup/sqlite_backup.py`, testada em
`packages/backup/tests/`.

### Rodar um backup manual (fora do ciclo automático)

```bash
docker compose -f docker-compose.prod.yml run --rm --entrypoint python backup scripts/run_backup.py --once
```

### Restaurar um backup

**Nunca restaure por cima do volume com `api`/`listener` ainda escrevendo nele.**

1. Liste os backups disponíveis:
   ```bash
   docker compose -f docker-compose.prod.yml run --rm --entrypoint sh backup -c "ls -la /app/backups"
   ```
2. Pare `api` e `listener` (não o `backup`):
   ```bash
   docker compose -f docker-compose.prod.yml stop api listener
   ```
3. Copie o backup escolhido para dentro do volume de dados, substituindo `teleyes.db`:
   ```bash
   docker run --rm \
     -v teleyes_teleyes-data:/app/data \
     -v teleyes_teleyes-backups:/app/backups \
     alpine cp /app/backups/teleyes-<timestamp>.db /app/data/teleyes.db
   ```
   (o prefixo `teleyes_` no nome dos volumes depende do nome do projeto Compose — confira com
   `docker volume ls` se não bater.)
4. Suba `api` e `listener` de novo:
   ```bash
   docker compose -f docker-compose.prod.yml up -d api listener
   ```

Testado de ponta a ponta (inserir dado real → backup → copiar pra fora do container → abrir isolado e
confirmar os dados) em 2026-09-12, ver `TESTING.md` (Sprint 5, evidência S5-03) para o passo a passo exato
executado.
