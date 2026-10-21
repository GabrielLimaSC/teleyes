# Contributing

Thanks for your interest in teleyes. It is a small, single-admin, self-hosted project, so changes that keep it
small and operable by one person are the most welcome. Open an issue before starting anything large.

## Setup

Backend (Python 3.12+):

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Frontend (Node and npm):

```bash
cd apps/web
npm ci
```

## Checks to run before opening a pull request

From the repository root, with the virtualenv active:

```bash
pytest
ruff check .
mypy .
```

From `apps/web`:

```bash
npm run test          # Vitest
npx tsc -b            # type check
npm run lint          # Oxlint; do not add new warnings
npm run test:e2e      # Playwright, starts an isolated test backend and a Vite dev server
npm run test:e2e:demo # Playwright against a backend seeded with the demo data (ports 8198 and 5184)
```

The Playwright runs use fixed local ports (8199 for the test backend and 5183 for Vite; 8198 and 5184 for the demo run), so make sure they are
free first. It needs the backend virtualenv at `.venv` in the repository root.

Never run `ruff format` over the whole repository: it would rewrite unrelated files. Keep diffs focused.

## Conventions

- Branch from `dev` and open the pull request against `dev`.
- Code, identifiers and technical comments are in English. The dashboard interface is in Portuguese (pt-BR).
- Commit messages follow `type(scope): description`. The project writes the description in Portuguese
  (for example `fix(feed): corrige o agrupamento de ofertas`); English is acceptable for outside contributors.
- Add or update tests proportional to the risk of the change.
- Never commit secrets, Telegram `.session` files, `.env`, databases or backups. See [SECURITY.md](SECURITY.md).
