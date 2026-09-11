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
