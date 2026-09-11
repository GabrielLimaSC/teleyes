# teleyes — Especificação do projeto

## 1. Resultado esperado

O teleyes é um serviço pessoal e de usuário único que acompanha grupos de promoções do Telegram já
acessíveis pela conta configurada. Ele analisa mensagens em segundos, encontra ofertas conforme regras
criadas no painel, evita alertas repetidos e envia uma mensagem privada pelo bot do teleyes.

O projeto precisa continuar operando no computador doméstico sem uma sessão de desenvolvimento aberta.
Após configuração inicial, reinício do processo ou da máquina deve recuperar a operação automaticamente.

## 2. Pessoas e permissões

- **Gabriel:** administrador do painel. Conecta o Telegram, gerencia grupos, regras e destinatários, vê
  histórico e saúde do sistema.
- **Namorada:** destinatária opcional. Na v1 não precisa de login; inicia uma conversa com o bot e pode
  receber regras destinadas a ela.

O sistema é single-tenant. Multiusuário completo, convites e permissões granulares ficam fora da v1.

## 3. Fluxo ponta a ponta

1. A sessão Telethon recebe ou recupera uma mensagem de um grupo monitorado.
2. O sistema normaliza texto e links, registra somente metadados operacionais temporários e executa as
   regras ativas aplicáveis àquela fonte.
3. Termos positivos e alternativos qualificam o candidato; bloqueios eliminam falsos positivos.
4. Quando houver teto de preço, o extrator identifica valores em reais e a regra define como tratar
   mensagem sem preço ou com múltiplos preços.
5. O deduplicador compara texto normalizado, links, produto, preço e janela da regra.
6. O match é persistido e publicado no feed por SSE.
7. O bot envia a notificação aos destinatários configurados e o status de entrega volta para o match.
8. O usuário abre a mensagem original quando o Telegram disponibilizar um link navegável.

## 4. Regras

Uma regra contém:

- `name` e `enabled`;
- `include_terms`: todos ou qualquer termo, com alternativas;
- `exclude_terms`;
- `max_price_cents` opcional;
- comportamento quando preço não for encontrado;
- grupos/fontes selecionados;
- destinatários: Gabriel, namorada ou ambos;
- janela de deduplicação;
- timestamps e contadores de matches/alertas.

Busca textual começa determinística, normalizando caixa, acentos e espaços. Regex e aproximação fuzzy só
entram depois de casos reais justificarem, pois aumentam falso positivo e dificuldade de explicação.

## 5. Dados persistidos

- configurações e estado de conexão;
- fontes/grupos selecionados e último message ID processado;
- regras e destinatários;
- mensagens que produziram match;
- relação match-regra e tentativas de notificação;
- assinaturas de deduplicação com expiração;
- métricas agregadas de mensagens vistas, descartadas e falhas;
- sessão MTProto em volume secreto separado do banco da aplicação.

Conteúdo de mensagens rejeitadas não é armazenado. Logs nunca incluem token, API hash, código de login,
senha 2FA ou conteúdo completo da sessão.

## 6. Componentes

```text
apps/api
  FastAPI, autenticação do painel, CRUD, SSE e health endpoints

packages/telegram
  cliente Telethon, descoberta de grupos, updates e backfill

packages/rules
  normalização, preço, matching e deduplicação

packages/notifications
  envio pelo Bot API e registro de entrega

apps/web
  React/Vite/TypeScript

data
  SQLite WAL, sessão Telegram e backups (fora do Git)
```

O backend roda como um único processo na v1. Separar worker, API, Redis ou Postgres só acontece se dados
reais mostrarem contenção ou necessidade de escala; não são requisitos iniciais.

## 7. API e tempo real

REST cobre autenticação, regras, fontes, destinatários, matches, métricas, configuração segura e teste de
notificação. SSE publica criação/atualização de match, entrega de alerta, mudança de conexão e métricas.
O navegador reconecta automaticamente e recupera eventos perdidos pelo último event ID ou refaz a
consulta REST.

## 8. Autenticação e acesso remoto

O painel terá uma conta administrativa local com senha Argon2 e cookie HttpOnly/Secure/SameSite. O serviço
escuta apenas em localhost e é publicado para os dispositivos autorizados com Tailscale Serve. Tailscale
é a fronteira de rede; o login do painel continua existindo conforme pedido do produto.

Não usar Tailscale Funnel, port forwarding ou exposição pública na v1.

## 9. Operação 24/7

- Docker Compose com política `restart: unless-stopped` e healthcheck.
- Banco e sessão em volumes persistentes com permissões restritas.
- Migração antes de iniciar a API.
- Backfill limitado pelo último ID/horário após reconexão.
- Estado visível: conectado, reconectando, bloqueado por autenticação e última mensagem processada.
- Heartbeat externo opcional sem conteúdo sensível para detectar máquina, internet ou serviço offline.
- Backup rotativo do SQLite e instrução de restauração testada.
- Configuração do sistema operacional para iniciar o runtime no boot, impedir suspensão e recuperar após
  queda de energia. O mecanismo exato depende do SO do desktop e será fechado antes do deploy.

## 10. Segurança e Telegram

A sessão MTProto equivale a um login da conta. Ela não entra no repositório, não é devolvida pela API e
fica fora do diretório servido ao frontend. Recomenda-se uma conta Telegram dedicada que participe dos
grupos necessários, reduzindo o impacto de perda da sessão ou restrição da conta principal.

O cliente é somente leitura nos grupos: não responde, reage, entra automaticamente, encaminha em massa ou
simula engajamento. O bot de alertas só envia aos chat IDs previamente cadastrados após `/start`.

## 11. Páginas do frontend

1. Login.
2. Visão geral/feed ao vivo.
3. Regras: criar, editar, pausar, testar e duplicar.
4. Fontes: listar grupos acessíveis, selecionar monitorados e mostrar último evento.
5. Histórico: busca e filtros por regra, destinatário, grupo, preço e entrega.
6. Saúde/configurações: Telegram, bot, SSE, versão, uptime, backup e teste de alerta.

O Impeccable trabalha em modo `Operate` e usa fluxo comp-first. O Codex de Design gera as alternativas;
Gabriel escolhe o mockup antes da implementação visual definitiva.

## 12. Entregas por fase

### Sprint 0 — Alinhamento e riscos

Tech Lead revisa este documento, confirma decisões delegadas, identifica lacunas e transforma cada sprint
em tasks com `done_when`, dono e testes. Não reabre decisões já confirmadas sem evidência nova.

### Sprint 1 — Vertical slice real

Estrutura Python, SQLite e configuração segura. Autenticação MTProto real, seleção de um grupo, uma regra
simples, persistência de um match e alerta real do bot. Demonstração: mensagem controlada contendo termo
configurado produz exatamente uma notificação.

### Sprint 2 — Regras e resiliência

CRUD completo, preço, bloqueios, grupos, destinatários, deduplicação, backfill, reconexão e métricas.
Demonstração: matriz de mensagens prova matches, descartes e ausência de duplicação.

### Sprint 3 — API e acesso

Login, REST, SSE, health e contrato do frontend. Demonstração: feed recebe match ao vivo e reconecta sem
perder estado.

### Sprint 4 — Frontend com Impeccable

PRODUCT.md, conceito visual, mockups pelo Codex de Design, escolha do Gabriel, implementação pelo Dev,
responsividade, acessibilidade e estados completos. Demonstração em browsers desktop e mobile reais.

### Sprint 5 — Operação doméstica

Docker Compose, volumes, backup/restauração, Tailscale Serve, boot do SO, prevenção de suspensão,
heartbeat e runbook. Demonstração: reiniciar processo/máquina e validar recuperação, acesso remoto e novo
alerta.

## 13. Portões que exigem Gabriel

- Criar/fornecer `api_id` e `api_hash` em ambiente local.
- Fazer o login inicial da conta, código e 2FA; agentes nunca solicitam esses segredos no chat.
- Criar o bot no BotFather, iniciar as conversas e cadastrar chat IDs.
- Informar o sistema operacional do desktop de produção.
- Instalar/autorizar Tailscale nos dispositivos.
- Escolher o mockup visual da Sprint 4.
