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

## 5. Rodar o pipeline de verdade

```bash
python scripts/run_pipeline_demo.py \
  --source-chat-id <chat_id do grupo, ex.: -1001079131412> \
  --source-name "Pelando Promoções" \
  --rule-name "Demo" --include-terms "promo,promoção" \
  --recipient-chat-id <chat_id do passo 4> --recipient-name "Gabriel"
```

O script aplica as migrations pendentes automaticamente (não precisa rodar
`alembic upgrade head` à parte), cadastra ou reaproveita a fonte/regra/
destinatário indicados, conecta na sessão salva no passo 3 e fica escutando
mensagens novas do grupo. Cada mensagem passa pelo pipeline completo (regra →
preço → dedupe → persistência → notificação); se bater com a regra, envia o
alerta de verdade para o `chat_id` do destinatário. Ctrl+C encerra.

Para o `done_when` do S1-06: poste no grupo uma mensagem controlada contendo
o termo da regra, confirme que o alerta chega no celular, depois poste a
**mesma mensagem de novo** e confirme que **não chega um segundo alerta**
(enquanto o script continua rodando — reiniciar o processo entre as duas
postagens não está coberto ainda, é limitação conhecida documentada no PR do
S1-07/S1-08).
