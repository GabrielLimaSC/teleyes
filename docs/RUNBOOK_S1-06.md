# Runbook S1-06 — credenciais reais e primeiro alerta

Este runbook cobre só a parte que só o Gabriel pode fazer: preencher segredos e
completar o login interativo do Telegram. Nenhum passo aqui pede para colar
telefone, código, senha 2FA ou token em chat — tudo acontece no terminal local.

## 1. Preencher o `.env`

```bash
cp .env.example .env
```

Edite `.env` e preencha:

- `TG_API_ID` / `TG_API_HASH` — obtidos em https://my.telegram.org/apps.
- `BOT_TOKEN` — criado com o @BotFather no Telegram.

`.env` nunca é commitado (já está no `.gitignore`).

## 2. Instalar dependências (se ainda não tiver o ambiente)

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## 3. Login interativo do Telethon

```bash
python scripts/telegram_login.py
```

O script pede telefone, código de confirmação (SMS ou app) e senha 2FA (se
houver) diretamente no terminal. Ao final:

- A sessão MTProto fica salva em `data/teleyes.session` (fora do Git, nunca
  commitar nem compartilhar — equivale ao login completo da conta).
- O script lista os últimos diálogos visíveis para essa conta. Confirme que o
  grupo que você quer monitorar aparece na lista.

## 4. Bot do BotFather

1. No Telegram, envie `/start` para o bot criado (usando o celular que deve
   receber os alertas).
2. Descubra o `chat_id` desse celular — por exemplo, abrindo
   `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates` no navegador logo
   após enviar `/start` e lendo `message.chat.id` da resposta.
3. Cadastre esse `chat_id` como destinatário allowlisted (via
   `apps/api/repositories/recipient_repo.py` por enquanto — não há API HTTP
   ainda, isso é Sprint 3).

## 5. Estado atual do pipeline (importante)

O login (passo 3) e a listagem de diálogos já são reais e testáveis nesta
etapa — é a parte que desbloqueia o portão humano do S1-06.

O que **ainda não existe** é um processo único que liga tudo:
ouvir mensagens reais de uma fonte configurada → aplicar `MatchRule` →
extrair preço → verificar dedupe → persistir `Match`/`Delivery` → notificar
via `BotNotifier`. Os componentes já existem e têm testes próprios
(`packages/telegram`, `packages/rules`, `apps/api/repositories`,
`packages/notifications`), mas a integração final ainda não foi quebrada em
task pelo Tech Lead. Enquanto essa task não existir, o `done_when` do S1-06
("mensagem controlada em grupo real produz exatamente um match persistido e
um alerta real no celular") não pode ser fechado — só o login pode.
