# teleyes

Monitor pessoal de promoções do Telegram. Uma sessão MTProto lê grupos que a conta configurada já pode
acessar, aplica regras de palavras-chave/preço/fontes/bloqueios, remove duplicatas e envia alertas por um
bot privado do Telegram. Um painel web mostra o feed, o histórico e a saúde do sistema em tempo real.

Produto de administrador único (Gabriel) rodando 24/7 num desktop doméstico via Docker Compose. Sem
multiusuário, sem exposição pública — acesso remoto é só via Tailscale Serve (ainda não configurado nesta
árvore de tasks; ver `TASKS.md`). O estado atual de cada sprint/task fica em `TASKS.md`; este documento é
o runbook operacional — como instalar, rodar, atualizar, diagnosticar e desligar o sistema — não um
histórico de progresso.

## Stack

- Python, FastAPI, Telethon e SQLAlchemy/Alembic
- SQLite em modo WAL
- React, Vite e TypeScript
- Server-Sent Events para o feed em tempo real
- Docker Compose para operação 24/7 (`docker-compose.prod.yml`: `api`, `listener`, `backup`, `web`)
- Tailscale Serve para acesso remoto privado (pendente de configuração)

Nenhuma credencial ou sessão do Telegram deve ser versionada — `.env`, `*.session` e `data/` já estão no
`.gitignore`.

## Índice

- [Primeira instalação](#primeira-instalação)
- [Operação do dia a dia](#operação-do-dia-a-dia)
- [Atualizar para uma nova versão](#atualizar-para-uma-nova-versão)
- [Diagnóstico](#diagnóstico)
- [Desligar com segurança](#desligar-com-segurança)
- [Backup e restauração](#backup-e-restauração)
- [Boot automático, energia e recuperação (Windows)](#boot-automático-energia-e-recuperação-windows)
- [Contrato da API](#contrato-da-api)

## Primeira instalação

Pressupõe Docker Desktop já instalado e rodando. No Windows de produção, veja também
[Boot automático, energia e recuperação](#boot-automático-energia-e-recuperação-windows) antes de
considerar a instalação completa.

1. **Clonar o repositório e configurar segredos**:
   ```bash
   git clone <url-do-repositório> teleyes
   cd teleyes
   cp .env.example .env
   ```
   Edite `.env` e preencha:
   - `TG_API_ID` / `TG_API_HASH` — criados em https://my.telegram.org/apps (uma conta Telegram real, de
     preferência dedicada — ver `CLAUDE.md`, seção Segurança).
   - `BOT_TOKEN` — criado com o [@BotFather](https://t.me/BotFather) no Telegram.
   - `HEARTBEAT_URL` — opcional; URL de ping fornecida por um monitor externo (por exemplo,
     healthchecks.io). Deixe vazia para desativar. Trate a URL como segredo: o identificador normalmente
     fica no próprio caminho.
   - `HEARTBEAT_INTERVAL_SECONDS` — intervalo entre tentativas enquanto o listener está conectado
     (padrão: 300 segundos).
   - `APP_ENV=production` — `.env.example` traz `development` (valor de desenvolvimento); numa instalação
     de produção de verdade, troque, já que esse valor aparece em `GET /health` (ver
     [Diagnóstico](#diagnóstico)) e ajuda a distinguir os dois ambientes de relance.

   Sem `TG_API_ID`/`TG_API_HASH`/`BOT_TOKEN`, `api`/`listener` sobem normalmente mas ficam honestamente
   `not_configured` (ver [Diagnóstico](#diagnóstico)) — nada finge estar conectado.

2. **Construir as imagens**:
   ```bash
   docker compose -f docker-compose.prod.yml build
   ```

3. **Login interativo do Telegram** (uma vez, cria a sessão MTProto dentro do volume que os containers
   realmente usam — nunca rode `scripts/telegram_login.py` fora de um container em produção, ele escreveria
   num `data/` local que os containers não veem, já que `docker-compose.prod.yml` usa um volume nomeado, não
   um bind mount):
   ```bash
   docker compose -f docker-compose.prod.yml run --rm --entrypoint python api scripts/telegram_login.py
   ```
   Pede telefone, código de confirmação (SMS ou app) e senha 2FA (se houver) diretamente no terminal — nunca
   cole nada disso em chat. Ao final, lista os últimos diálogos visíveis; confirme que o(s) grupo(s) que
   você quer monitorar aparece(m) na lista.

4. **Criar a senha do painel** (uma vez — sem isso não existe nenhuma forma de logar):
   ```bash
   docker compose -f docker-compose.prod.yml run --rm --entrypoint python api scripts/create_admin.py
   ```
   Pede a senha duas vezes (mínimo 8 caracteres). Rodar de novo mais tarde redefine a senha em vez de criar
   um segundo administrador — o produto é single-admin por design (`apps/api/models/admin.py`).

5. **Subir tudo**:
   ```bash
   docker compose -f docker-compose.prod.yml up -d
   ```
   Sobe `api`, `listener`, `backup` e `web`. `api` roda as migrations do Alembic automaticamente antes de
   aceitar tráfego — não precisa rodar `alembic upgrade head` à parte.

6. **Cadastrar fonte(s), regra(s) e destinatário(s) ativos e allowlisted pelo painel** (`http://localhost:8080`
   nesta máquina, ou pela URL do Tailscale Serve quando configurado). Sem pelo menos um de cada, ativo, o
   `listener` fica honestamente ocioso (ver [Diagnóstico](#diagnóstico)) — ele lê essa configuração do banco
   uma vez, no start.

7. Reinicie `listener` pra ele pegar a configuração que você acabou de cadastrar:
   ```bash
   docker compose -f docker-compose.prod.yml restart listener
   ```

## Operação do dia a dia

- **Painel**: cadastro/edição de fontes, regras e destinatários é todo pelo painel web — não há CLI pra
  isso em produção (`scripts/telegram_login.py`/`create_admin.py` são as únicas exceções, ambos setup
  único). Mudanças feitas no painel só valem pro `listener` depois de reiniciá-lo
  (`docker compose -f docker-compose.prod.yml restart listener`) — ele lê a configuração ativa do banco
  uma vez, no start, não observa mudanças ao vivo (limitação conhecida, ver `TESTING.md`, evidência S5-09).
- **Modelo de regras**: toda regra ativa é avaliada contra toda mensagem de toda fonte ativa; todo match
  vai pra todo destinatário ativo e allowlisted. Não existe associação seletiva regra↔fonte ou
  regra↔destinatário no schema atual — é fan-out total, não subscrição (decisão registrada em S5-09).
- **Ver o feed**: painel web, aba Feed/Histórico (SSE ao vivo).
- **Testar notificação**: painel web, aba Saúde, "Enviar teste" — dispara um envio real pelo bot pro
  destinatário escolhido, sem depender de uma mensagem real do Telegram.

## Atualizar para uma nova versão

```bash
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

`up -d` recria só os containers cuja imagem mudou; os que não mudaram continuam rodando sem interrupção.
Migrations do Alembic rodam automaticamente no boot do `api` — uma migration nova cadastrada no código
já sobe aplicada, sem passo manual. `listener` e `backup` reaproveitam a mesma imagem do `api` (ver
`docker/api.Dockerfile`), então uma atualização de código neles também exige rebuildar essa imagem.

Se uma migration específica precisar rodar isolada antes de subir tudo (raro — só pra depurar uma
migration suspeita antes de deixá-la rodar automaticamente):
```bash
docker compose -f docker-compose.prod.yml run --rm --entrypoint sh api -c "alembic -c apps/api/alembic.ini upgrade head"
```

## Diagnóstico

**Status geral**:
```bash
docker compose -f docker-compose.prod.yml ps
```
`api` e `web` têm healthcheck (`healthy`/`unhealthy` aparece na saída); `listener` e `backup` não têm
(processos de fundo sem superfície HTTP pra sondar — `restart: unless-stopped` sozinho já cobre a
recuperação de crash, ver `docker-compose.prod.yml`).

**Logs de cada serviço**:
```bash
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f listener
docker compose -f docker-compose.prod.yml logs -f backup
docker compose -f docker-compose.prod.yml logs -f web
```

**Saúde da API** (também disponível no painel, aba Saúde):
```bash
curl http://localhost:8080/health
```
```json
{
  "status": "ok",
  "env": "production",
  "version": "0.1.0",
  "uptime_seconds": 123.4,
  "telegram": {"configured": true, "state": "connected"},
  "bot": {"configured": true, "state": "configured"}
}
```
`status: "ok"` só significa que o processo `api` está de pé — não que o Telegram ou o bot estejam
conectados. Os campos que importam pra isso:

| `telegram.state` | Significado |
|---|---|
| `not_configured` | `TG_API_ID`/`TG_API_HASH` ausentes no `.env` |
| `connecting` | Tentando conectar agora |
| `connected` | Sessão MTProto ativa |
| `reconnecting` | Caiu, tentando reconectar (backoff exponencial) |
| `blocked` | Excedeu tentativas, ou a conta foi banida/revogada — investigar manualmente |

| `bot.state` | Significado |
|---|---|
| `not_configured` | `BOT_TOKEN` ausente no `.env` |
| `configured` | Token presente — não significa que o último envio teve sucesso, só que o notifier consegue tentar |

**`listener` ocioso ou não escutando de verdade**: cheque os logs (`docker compose logs listener`) — ele
imprime, no boot, quantas fontes/regras/destinatários ativos encontrou e por que ficou ocioso quando é o
caso (credencial ausente, ou nenhuma fonte/regra/destinatário ativo cadastrado). Reiniciá-lo depois de
cadastrar algo pelo painel resolve o segundo caso.

### Heartbeat externo opcional

Quando `HEARTBEAT_URL` está preenchida, o próprio processo `listener` envia periodicamente um `POST` sem
payload para essa URL, mas somente enquanto o cliente MTProto real reporta conexão ativa. O heartbeat não
parte da API: o `/health` da API comprova apenas que aquele processo está no ar e não representa a conexão
do listener separado.

Se a conexão cair, os pings param; quando ela voltar, retomam no próximo ciclo. Listener sem credenciais,
sem fonte/regra/destinatário ativo ou ocioso não envia sucesso. Falhas de rede e respostas HTTP de erro são
registradas sem a URL e tentadas novamente no próximo intervalo, sem interromper o processamento de
mensagens. Heartbeat atrasado significa, portanto, que o listener não está conectado ou que ele/serviço de
monitoramento/rede está indisponível — consulte os logs para distinguir as causas.

Para desligar, deixe `HEARTBEAT_URL=` vazia (ou remova a variável) e reinicie o listener. Nenhum endpoint
público, Tailscale Funnel ou redirecionamento de porta é criado por esse recurso.

## Desligar com segurança

`docker compose stop`/`down` (SIGTERM, com um período de graça antes de forçar) — nunca `docker compose
kill` nem `docker kill` direto num container, que mandam SIGKILL sem chance de encerramento organizado.

O ponto não é proteger o SQLite de corrupção — modo WAL é desenhado pra ser resistente a um processo
morto abruptamente no meio de uma escrita (na pior hipótese, a transação incompleta é descartada na
próxima abertura do banco, não corrompida; ver documentação do SQLite sobre WAL). O ponto real é permitir
que cada serviço termine com organização: `api` (uvicorn) fecha conexões HTTP em andamento em vez de
cortá-las na metade, `listener` roda `client.disconnect()` do Telethon (fecha a sessão do lado do
Telegram de forma limpa) e `backup` não é interrompido no meio de um `VACUUM INTO`.

```bash
# Parar tudo, mantendo os volumes (dados, sessão, backups) intactos
docker compose -f docker-compose.prod.yml stop

# Ou remover os containers também (os volumes continuam existindo — nomeados, não presos ao container)
docker compose -f docker-compose.prod.yml down
```

Os três processos de fundo (`api`, `listener`, `backup`) instalam handler próprio pra `SIGTERM`/`SIGINT` —
sem isso, cada um rodando como PID 1 do seu container não reagiria ao sinal e o Compose sempre esperaria o
período de graça inteiro antes de forçar (achado real de S5-09/S5-07, ver `TESTING.md`).

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

### 3. Login automático — decisão do Gabriel

"At log on" dispara tanto com login manual quanto com autologon do Windows configurado — mesmo gatilho
cobre os dois casos. **Gabriel escolheu autologon**: recuperação 100% automática depois de uma queda de
energia/reboot, sem precisar logar fisicamente — aceitando em troca que qualquer pessoa com acesso físico
à máquina em casa encontra a sessão já logada.

Configurar via [Autologon (Sysinternals)](https://learn.microsoft.com/sysinternals/downloads/autologon):

1. Baixe e rode `Autologon.exe` (não precisa instalar).
2. Preencha usuário, domínio (nome do computador, se não houver domínio de rede) e senha da conta do
   Windows.
3. Clique "Enable". O utilitário guarda a senha criptografada no registro (`LSA Secrets`) — não em texto
   puro num arquivo comum.
4. Reinicie uma vez pra confirmar que loga sozinho, sem pedir senha.

Pra reverter (voltar a exigir login manual): rode `Autologon.exe` de novo e clique "Disable".

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

## Contrato da API

`contracts/openapi.json` e `contracts/api-types.ts` são gerados a partir do schema OpenAPI que o FastAPI
expõe em `GET /openapi.json` — o contrato tipado que o frontend consome. Para regenerar depois de mudar
uma rota (ambiente de desenvolvimento, com a venv local):

```bash
source .venv/bin/activate
./scripts/generate_ts_client.sh
```

O teste `apps/api/tests/test_openapi_contract.py::test_committed_contract_file_matches_the_live_schema`
falha se `contracts/openapi.json` ficar desatualizado em relação ao schema real.
