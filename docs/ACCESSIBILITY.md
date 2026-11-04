# Accessibility

teleyes targets **WCAG 2.2 level AA** on every screen of the web panel, in both
themes (light and dark) and from 390px (phone) to 1440px (desktop).

## What is covered

- **Automated audit (axe-core).** `apps/web/e2e/a11y.spec.ts` opens every screen
  (Login, Início, Feed, Histórico, Economia with the purchase form, Regras with
  an expanded row and the recipient rail, Fontes with both tabs and the row
  menu, Saúde, Configuração, the product panel, the confirmation dialog) in
  light and dark, at 1440 and 390 px. It runs axe with the tags `wcag2a`,
  `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` and fails on any `serious` or
  `critical` violation.
- **Keyboard.** `apps/web/e2e/keyboard.spec.ts` drives the main flows with the
  keyboard: login, creating a rule, expanding a row (Enter / Esc), the `⋯` menu
  (ArrowDown opens; arrows, Home and End move; Esc closes and returns focus),
  opening and closing the product panel, registering a purchase, and the
  confirmation dialog.
- **Skip link.** The first Tab stop is "Pular para o conteúdo", which moves
  focus to `<main>`.
- **Dialogs.** Confirmation and session-expired dialogs trap Tab/Shift+Tab, close
  with Esc (confirmation) and give focus back to whatever opened them. The product
  panel traps focus when it is a full-screen sheet or drawer, and always returns
  focus to its trigger on close.
- **Screen readers.** Icon-only buttons have accessible names; toasts live in a
  persistent polite live region; new alerts arriving in the Feed are announced
  once per batch ("2 novos alertas no feed."), never for the first load; tables
  have proper headers; price charts expose a text summary (lowest, highest and
  latest price); status is always conveyed with text, not color alone.
- **Contrast.** `src/styles/contrast.test.ts` measures every text/background
  pair of both themes (4.5:1 text, 3:1 for icons and the focus ring). The former
  light-theme "debt" list is empty.
- **Motion.** `prefers-reduced-motion: reduce` disables all animations and
  transitions (global rule in `src/index.css`); the keyboard spec checks that no
  infinite or long animation is running on the main screens.
- **Reflow and zoom.** No horizontal page scroll at 720 px (200 % zoom of a
  1440 px window) and at 320 px (400 %).
- **Document.** `<html lang="pt-BR">` and one `document.title` per route
  (for example "Regras · teleyes").
- **Target size.** Interactive targets are at least 24 x 24 px (axe `target-size`).

## Running the checks

From `apps/web`:

```bash
npm test                                  # unit tests, including contrast
npx playwright test a11y keyboard         # axe audit + keyboard flows
```

The e2e suite starts its own backend and Vite server (see
`playwright.config.ts`). If those ports are taken on your machine, use a local
copy of the config with other ports.

## Known limitations

- axe-core finds roughly a third of WCAG problems. The spec cannot judge reading
  order, meaningful alt text or whether a screen reader announcement is pleasant;
  those were reviewed by hand and should be re-checked with VoiceOver / NVDA
  before a major release.
- Only `serious` and `critical` violations fail the build. `moderate` and `minor`
  findings are not enforced.
- The product-panel range tabs (7d / 30d / 90d) are buttons with `role="tab"` but
  do not implement arrow-key navigation between tabs; each is reachable with Tab.
- The decorative glass effects rely on `backdrop-filter`; browsers in forced-colors
  mode fall back to the system palette and are not specifically tested.
- Contrast is verified from the declared design tokens and by axe on rendered
  pages, but not over arbitrary user content (for example images in cards).
