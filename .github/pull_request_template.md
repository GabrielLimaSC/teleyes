## What changed and why

## Checklist

- [ ] Branched from `dev` and this pull request targets `dev`
- [ ] `pytest`, `ruff check .` and `mypy .` pass (backend)
- [ ] `npm run test`, `npx tsc -b` and `npm run lint` pass in `apps/web`, with no new lint warnings
- [ ] Added or updated tests proportional to the risk
- [ ] Ran `npm run test:e2e` if the change touches the UI
- [ ] Code and technical comments are in English
- [ ] No `ruff format` over unrelated files; the diff is focused
- [ ] No secrets, `.session` files, `.env`, databases or backups in the diff
