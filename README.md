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

## Boot automático, energia e recuperação (Windows)

Pensado pro desktop doméstico rodando o teleyes 24/7 recuperar sozinho depois de um reboot ou queda de
energia, sem ninguém precisar digitar comando nenhum. Scripts em `ops/windows/`.

**Nada disto foi testado num Windows real ainda** — escrito e revisado numa worktree Mac, sem acesso a um
Windows de verdade. A validação real (reboot de verdade recuperando os containers sozinho) é o
`done_when` da task S5-06 e fica pendente do teste do Gabriel no desktop de casa — revise os scripts antes
de rodar em produção.

### 1. Docker Desktop inicia no login

Configuração manual, uma vez: Docker Desktop → Settings → General → marcar "Start Docker Desktop when you
log in". Sem isso nada do resto funciona — Docker Desktop não é um serviço do Windows, é um app por
usuário que só sobe quando alguém loga.

### 2. Registrar a Tarefa Agendada

Como Administrador, uma vez:

```powershell
cd caminho\pro\repositorio\ops\windows
.\register-teleyes-task.ps1
```

Cria a tarefa `teleyes-startup`, disparada "At log on" do usuário atual, chamando `start-teleyes.ps1` —
que espera o Docker Desktop ficar pronto (até 3 minutos, configurável via parâmetro) antes de rodar
`docker compose -f docker-compose.prod.yml up -d`. Log em `data\startup.log`.

Por que "At log on" e não "At startup": Docker Desktop só sobe depois de alguém logar, então uma tarefa
"At startup" rodaria cedo demais, antes do Docker Desktop sequer ter começado a iniciar.

### 3. Login automático ou manual — decisão do Gabriel

"At log on" dispara tanto com login manual quanto com autologon do Windows configurado — mesmo gatilho
cobre os dois casos. Duas opções, escolha uma:

- **Login manual** (mais seguro, padrão recomendado): depois de uma queda de energia/reboot, alguém
  precisa logar fisicamente (ou via RDP) uma vez pra tarefa disparar. Sem exposição extra de segurança.
- **Autologon** (recuperação 100% sem intervenção humana, troca por segurança física menor): configura o
  Windows pra logar sozinho no boot, sem senha digitada por ninguém — qualquer pessoa com acesso físico à
  máquina liga e já encontra a sessão logada. Ferramenta oficial:
  [Autologon (Sysinternals)](https://learn.microsoft.com/sysinternals/downloads/autologon). Só habilitar
  se o risco de acesso físico de terceiros à máquina em casa for aceitável.

### 4. Energia: nunca suspender na tomada

Como Administrador, uma vez:

```powershell
cd caminho\pro\repositorio\ops\windows
.\configure-power-settings.ps1
```

Ou manualmente: Configurações → Sistema → Energia e bateria → Telas e suspensão → "Quando conectado" =
Nunca (tela e suspensão).

### 5. BIOS/UEFI: ligar sozinho ao voltar energia

Fora do controle do Windows — precisa ser configurado na BIOS/UEFI da placa-mãe (geralmente "Restore on
AC Power Loss", "AC Power Recovery" ou nome parecido, dentro de "Power Management"). Setar pra "Power On"
(ou equivalente). Sem isso, uma queda de energia real deixa a máquina desligada até alguém apertar o botão
físico — nada nos scripts desta task ajuda nesse caso específico, porque nada roda antes da máquina ligar.

### Verificar e testar

```powershell
# Confere que a tarefa está registrada
Get-ScheduledTask -TaskName teleyes-startup

# Testa sem precisar reiniciar de verdade
Start-ScheduledTask -TaskName teleyes-startup
Get-Content data\startup.log -Tail 20 -Wait
```
