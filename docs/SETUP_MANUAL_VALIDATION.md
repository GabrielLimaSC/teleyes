# Manual validation of the setup wizard against real Telegram (S19-02)

Automated tests run the whole wizard against a fake Telegram account and a fake bot. They prove the
logic, the error mapping and the security properties; they **cannot** prove that Telegram accepts the
calls. Run this checklist once with a **test account** (a spare SIM/number, not your main one) on a
throw-away install before trusting the wizard.

Setup: `COMPOSE_PROJECT_NAME=teleyes-wizard-test ./install.sh --port 18090` in a fresh clone (so the
volumes are new), then open `http://127.0.0.1:18090`. Clean up with
`COMPOSE_PROJECT_NAME=teleyes-wizard-test docker compose down -v`.

| # | Step | Do | Expect |
|---|---|---|---|
| 1 | Banner | Log in. | Feed and Saúde show the "configure o Telegram" call to action; Saúde says Telegram "Não configurado". |
| 2 | Credentials, bad | Enter a wrong `api_hash` (32 hex chars, but not yours) and continue to the phone step. | The code request fails with "O Telegram recusou o api_id/api_hash" (`ApiIdInvalid`). |
| 3 | Credentials, good | Enter your real `api_id`/`api_hash` from <https://my.telegram.org/apps>. | Step marked done; the hash is never shown again. |
| 4 | Phone, bad format | Type `11999998888` (no `+`). | Format error, nothing sent to Telegram. |
| 5 | Phone | Type the test account's number in `+<country><number>`. | A login code arrives **inside the Telegram app** of that account ("Telegram" service chat), not by SMS. Screen shows the masked number and a countdown (5 min). |
| 6 | Wrong code | Type a wrong code. | "Código incorreto", you may retry; after 5 misses the login is discarded and a new code is needed. |
| 7 | Reload mid-login | Reload the tab at the code step. | The wizard returns to the code step with the same masked number (state is on the server). |
| 8 | Code | Type the right code. | If the account has 2FA, a password prompt appears; otherwise the step completes. |
| 9 | 2FA | Wrong password, then the right one. | "Senha ... incorreta" first, then success. |
| 10 | Session file | `docker compose exec api ls -l /app/session`. | `teleyes.session` and `secrets.json`, both `-rw-------`, directory `drwx------`. No `.pending.session` left. |
| 11 | Flood wait | (Optional) request codes repeatedly. | A message with the wait time Telegram asked for, and the dashboard rate limit after 3 starts. |
| 12 | Bot token | Create a bot with @BotFather and paste the token. | The bot's `@username` is shown; the token is not. A wrong token gives "O Telegram não reconheceu este token". |
| 13 | Pairing | Click the pairing link / open the bot and press Start. | Within a few seconds the recipient appears with your first name and an editable name. A second Telegram account sending plain `/start` is **not** added. |
| 14 | Test message | Click "Enviar mensagem de teste". | The test text arrives from the bot on the phone. |
| 15 | Webhook conflict | (Optional) set a webhook on the bot, then pair. | The "outro programa ou webhook" message. |
| 16 | Groups | Open the groups step. | The listener (not the api) lists the groups and channels the test account is in; private chats and bots are absent. Pick two. |
| 17 | Read-only | Check the groups. | The test account did not join, post, react or forward anything. |
| 18 | First rule | Create a rule from a template. | "Tudo pronto" with the live checks: listener connected, bot ok, 1 source, 1 rule. |
| 19 | End to end | Post a matching message in a picked group (from another account). | A match shows in the Feed and the alert reaches the phone. |
| 20 | Persistence | `docker compose restart`. | The wizard shows everything done and the listener reconnects with no re-login. |
| 21 | Disconnect | Use "Desconectar Telegram" and confirm. | Session, hash and token are gone from `/app/session`; the listener returns to idle; the wizard restarts at step 1. Also end the session in Telegram, Settings, Devices. |
| 22 | No leaks | `docker compose logs api listener \| grep -i -E "hash|token|code|\+55"`. | No secret, code, phone or token in the logs. |

Report any step that fails with the **error code** shown in the UI (not secrets) and the relevant log
lines with values removed.
