# S12-01 — Inventário de literais de cor

Levantado em 2026-09-19, sobre `origin/dev` (`85c11a9`), para tornar o app tematizável sem mudar o tema claro.
Este arquivo é o anexo pedido na ficha da S12-01; o número de linhas abaixo vem do `git diff` entre o commit do
baseline visual (`f1b9a13`, app ainda intocado) e o commit que troca os literais por tokens.

**Resultado:** 160 literais em 20 arquivos, todos trocados por `var(--…)` (79 tokens novos em
`styles/materials.css`). O teste `src/styles/colorLiterals.test.ts` falha se qualquer literal de cor reaparecer fora de
`styles/tokens.css`, `styles/materials.css` e `public/favicon.svg`.

## Como foi levantado

- Padrões: hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), `rgb()/rgba()/hsl()/hsla()/hwb()/lab()/lch()/oklab()/oklch()/color()` e cores
  nomeadas (`white`, `black`, …), em `.css`, `.ts`, `.tsx`, `.html` e `.svg`, contando também gradientes, sombras, `filter`,
  `style={{}}` inline e constantes em objetos TS. Comentários são ignorados.
- O grep inicial da ficha era incompleto: além dos arquivos listados lá, havia literais em `GlassCard.css`, `FillButton.css`,
  `FeedPage.css` e nas constantes de `LoginPage.tsx`, `FeedPage.tsx` e `SaudePage.tsx`.

## O que **não** é literal de cor (verificado, sem mudança)

| Onde | Por quê |
|---|---|
| `NavCapsule.tsx` — filtro SVG `#nav-glass-refraction` | `feTurbulence` + `feDisplacementMap` só têm números; `colorInterpolationFilters="sRGB"` é espaço de cor, não cor. Não precisa de allowlist. |
| `CategoryIcon.tsx` | usa `stroke="currentColor"` (herda o `color` do tile). |
| `CrudTable.css` | `color-mix(in srgb, var(--color-danger) 30%, transparent)` — só token e `transparent`. |
| `public/mascot.png` | bitmap (gato preto RGBA); tratamento no escuro é da S12-03. |
| `transparent`, `currentColor` | palavras-chave, não valores de cor. |

## Allowlist do teste (com justificativa)

| Arquivo | Motivo |
|---|---|
| `src/styles/tokens.css` | define a camada `--color-*` (Dub/CRUD): é a fonte dos valores claros. |
| `src/styles/materials.css` | define a camada `--plane-*` e os tokens semânticos da S12-01: fonte dos valores claros. |
| `public/favicon.svg` | asset estático independente (5 cores próprias); não lê variáveis CSS da página. Variante escura é S12-03/04. |

## Prova de que o tema claro não mudou

Baseline tirado com o app **intocado** (commit `f1b9a13`) e repetido depois da troca. 62 fotos: Login (anônimo, erro,
autenticado), Feed (vazio, com dados, regra selecionada, SSE aberto/caiu, tooltip, offline, menu mobile), Histórico (vazio,
com dados, tooltip, filtro sem resultado), Regras (vazio, com dados, **linha em edição**, testador, confirmação de limpar,
erro do formulário, toast), Fontes (vazio, com dados, formulário), Saúde (5 estados do Telegram, SSE, teste entregue/erro,
erro de health) e uma tela com todas as pílulas de entrega e os 5 tiles de categoria; cada uma em 1440px e 390px, com dado
semeado real, exceto as duas telas de estados forçados (pílulas e Saúde), que usam resposta simulada só para alcançar
estados que a API de teste não produz.

As fotos **não são versionadas** (`apps/web/e2e/visual-baseline/` está no `.gitignore`): dependem do SO/navegador que as
renderizou e o app roda em Windows em produção. O baseline é gerado localmente no commit de referência e comparado depois:

```
VISUAL=1 VISUAL_STYLES_OUT=/tmp/before npx playwright test e2e/visual.spec.ts --update-snapshots=all   # no commit de referência
VISUAL=1 VISUAL_STYLES_OUT=/tmp/after  npx playwright test e2e/visual.spec.ts                          # no commit testado
node scripts/compare-computed-styles.mjs /tmp/before /tmp/after                                        # comparação exata
```

- **Estilos computados (exato):** `62 shots, 8463 element comparisons, 0 differences` — cor, fundo, gradientes, bordas,
  sombras, filtros, `backdrop-filter`, `fill`/`stroke`, incluindo `::before/::after` e o markup do filtro SVG.
- **Pixels (estrito, limiar 0):** antes × depois, 62 fotos: no máximo 5 fotos com algum pixel diferente, no máximo 24 pixels
  por foto, diferença máxima de **1 nível em 255**. Duas execuções do *mesmo* código entre si dão o mesmo tipo de ruído
  (4 fotos, 61 pixels, 1 nível): é oscilação de raster do `backdrop-filter`, não mudança de cor. A asserção do Playwright
  usa limiar 0.02 (absorve esse ruído; qualquer mudança real de cor fica muito acima).
- Para o resultado ser repetível foi preciso: raster por software (`--disable-gpu`), animações congeladas (o Aurora Glow gira
  sem parar), textos que dependem do relógio trocados por constantes (hora do card, "Último match", uptime) e o relógio da
  página parado enquanto o toast é fotografado.

## Literais trocados, arquivo a arquivo

Cada linha é um trecho do arquivo **antes** da mudança (número de linha do commit `f1b9a13`) e os tokens que o substituíram.
Gradientes e sombras compostos viraram um token inteiro (o tema escuro poderá mudar geometria e cores juntos);
`--aurora-angle` continua sendo a propriedade animada e por isso o `conic-gradient` do Aurora Glow mantém `var(--aurora-angle)`
no CSS, com só as cores como tokens.

### `src/components/AuroraGlow.css`

| linha (antes) | literais | vira |
|---|---|---|
| 17 | `#5b8dfb`, `#a35bfb`, `#fb5ba0`, `#4ce8a8`, `#5b8dfb` | `--aurora-angle`, `--aurora-1`, `--aurora-2`, `--aurora-3`, `--aurora-4` |
| 29 | `#ffffff` | `--aurora-card-bg` |

### `src/components/FillButton.css`

| linha (antes) | literais | vira |
|---|---|---|
| 19 | `rgba(255, 255, 255, 0.18)` | `--fill-bloom-bg` |

### `src/components/GlassCard.css`

| linha (antes) | literais | vira |
|---|---|---|
| 2 | `rgba(255, 255, 255, 0.6)` | `--glass-card-bg` |
| 6 | `rgba(255, 255, 255, 0.4)`, `rgba(255, 255, 255, 0.8)`, `rgba(15, 15, 20, 0.08)` | `--glass-card-border-color`, `--glass-card-border-top-color`, `--glass-card-shadow` |

### `src/components/MatchCard.css`

| linha (antes) | literais | vira |
|---|---|---|
| 20 | `#4b4b52` | `--text-muted` |
| 31 | `#08060d` | `--text-strong` |
| 48 | `#4b4b52` | `--text-muted` |
| 56 | `#8a8a92` | `--text-faint` |
| 74 | `#8a8a92` | `--text-faint` |
| 80 | `#17181c` | `--text-body` |
| 91 | `#6a3fbf` | `--text-violet` |
| 108 | `#08060d` | `--text-strong` |
| 120 | `#525866` | `--plane-text-secondary` |

### `src/components/NavCapsule.css`

| linha (antes) | literais | vira |
|---|---|---|
| 31 | `rgba(23, 23, 23, 0.13)`, `rgba(23, 23, 23, 0.09)` | `--nav-capsule-shadow` |
| 55 | `rgba(255, 255, 255, 0.12)` | `--nav-refraction-bg` |
| 66 | `#000`, `#000`, `#000`, `#000` | `--nav-refraction-mask` |
| 84 | `rgba(255, 255, 255, 0.76)`, `rgba(237, 239, 243, 0.42)`, `rgba(211, 214, 221, 0.55)`, `rgba(232, 234, 239, 0.42)` | `--nav-tint` |
| 96 | `rgba(255, 255, 255, 0.84)` | `--nav-shine-border-color` |
| 98 | `rgba(255, 255, 255, 0.92)`, `rgba(58, 61, 70, 0.18)`, `rgba(70, 74, 83, 0.19)` | `--nav-shine-shadow` |
| 145 | `#4b4b52` | `--nav-tab-text` |
| 160 | `#171717`, `rgba(255, 255, 255, 0.62)` | `--nav-tab-hover-text`, `--nav-tab-hover-bg` |
| 167 | `#ffffff`, `#171717`, `rgba(23, 23, 23, 0.2)`, `rgba(255, 255, 255, 0.24)` | `--nav-tab-active-text`, `--nav-tab-active-bg`, `--nav-tab-active-shadow` |
| 177 | `#3f3fb0` | `--nav-focus-ring-color` |
| 198 | `rgba(8, 6, 13, 0.28)`, `rgba(255, 255, 255, 0.32)` | `--nav-mascot-shadow` |
| 211 | `rgba(8, 6, 13, 0.3)`, `rgba(255, 255, 255, 0.44)` | `--nav-mascot-shadow-hover` |
| 233 | `rgba(0, 0, 0, 0.26)` | `--nav-mascot-image-shadow` |
| 272 | `#171717` | `--nav-brand-text` |
| 288 | `#4b4b52` | `--nav-tab-text` |
| 299 | `rgba(255, 255, 255, 0.88)` | `--nav-menu-border-color` |
| 302 | `rgba(237, 238, 242, 0.77)`, `rgba(23, 23, 23, 0.14)`, `rgba(255, 255, 255, 0.96)`, `rgba(79, 82, 91, 0.12)` | `--nav-menu-bg`, `--nav-menu-shadow` |

### `src/components/OfflineBanner.css`

| linha (antes) | literais | vira |
|---|---|---|
| 2 | `#8a6d00`, `#fffaf0` | `--offline-banner-bg`, `--offline-banner-text` |

### `src/components/TermChipsInput.css`

| linha (antes) | literais | vira |
|---|---|---|
| 25 | `#ccd2db`, `#fff` | `--plane-input-border-color`, `--plane-input-bg` |
| 47 | `#eef2f7` | `--plane-tint-bg` |
| 67 | `rgba(71, 86, 110, 0.16)` | `--plane-chip-remove-hover-bg` |
| 88 | `#6b7280` | `--plane-text-placeholder` |

### `src/components/adapterStateLabel.ts`

| linha (antes) | literais | vira |
|---|---|---|
| 9 | `#8a8a92`, `#8a6d00`, `#1c8a4b`, `#8a6d00`, `#b3261e` | `--pill-neutral-dot`, `--pill-warn-dot`, `--pill-good-dot`, `--pill-danger-dot` |
| 22 | `#1c8a4b`, `#8a8a92` | `--pill-good-dot`, `--pill-neutral-dot` |

### `src/components/deliveryStatus.ts`

| linha (antes) | literais | vira |
|---|---|---|
| 18 | `#8a8a92`, `#ececef`, `#4b4b52` | `--pill-neutral-dot`, `--pill-neutral-bg`, `--pill-neutral-fg` |
| 21 | `#1c8a4b`, `#e2f5e9`, `#166b3a` | `--pill-good-dot`, `--pill-good-bg`, `--pill-good-fg` |
| 26 | `#5b5bd6`, `#e9e9fb`, `#3f3fb0` | `--pill-info-dot`, `--pill-info-bg`, `--pill-info-fg` |
| 34 | `#5b5bd6`, `#e9e9fb`, `#3f3fb0` | `--pill-info-dot`, `--pill-info-bg`, `--pill-info-fg` |
| 40 | `#b3261e`, `#fbe4e2`, `#8c1d17` | `--pill-danger-dot`, `--pill-danger-bg`, `--pill-danger-fg` |
| 45 | `#8a6d00`, `#fbf1d6`, `#6b5400` | `--pill-warn-dot`, `--pill-warn-bg`, `--pill-warn-fg` |
| 51 | `#5b5bd6`, `#e9e9fb`, `#3f3fb0` | `--pill-info-dot`, `--pill-info-bg`, `--pill-info-fg` |
| 54 | `#8a8a92`, `#ececef`, `#4b4b52` | `--pill-neutral-dot`, `--pill-neutral-bg`, `--pill-neutral-fg` |
| 56 | `#8a8a92`, `#ececef`, `#4b4b52` | `--pill-neutral-dot`, `--pill-neutral-bg`, `--pill-neutral-fg` |

### `src/components/matchCategory.ts`

| linha (antes) | literais | vira |
|---|---|---|
| 30 | `#e3ecfb`, `#ece3fb`, `#fbeee3`, `#fbe3ef`, `#e9e9ec` | `--category-phone-bg`, `--category-laptop-bg`, `--category-headphones-bg`, `--category-gaming-bg`, `--category-generic-bg` |

### `src/index.css`

| linha (antes) | literais | vira |
|---|---|---|
| 22 | `rgba(91, 141, 251, 0.16)`, `rgba(163, 91, 251, 0.14)`, `rgba(251, 91, 160, 0.1)` | `--body-wash` |

### `src/pages/FeedPage.css`

| linha (antes) | literais | vira |
|---|---|---|
| 43 | `#fff2dc` | `--plane-status-warn-bg` |
| 143 | `rgba(255, 255, 255, 0.62)`, `rgba(255, 255, 255, 0.86)` | `--glass-chip-bg`, `--glass-inner-border-color` |
| 177 | `rgba(255, 255, 255, 0.7)`, `rgba(58, 61, 70, 0.08)` | `--glass-divider-bg`, `--glass-divider-shadow` |
| 230 | `rgba(255, 255, 255, 0.66)`, `rgba(255, 255, 255, 0.86)` | `--glass-tile-bg`, `--glass-inner-border-color` |

### `src/pages/FeedPage.tsx`

| linha (antes) | literais | vira |
|---|---|---|
| 12 | `#8b5a08`, `#176945`, `#a32a24` | `--plane-status-warn`, `--plane-status-good`, `--plane-status-danger` |
| 136 | `#176945`, `#47566e` | `--plane-status-good`, `--plane-status-neutral` |
| 140 | `#176945`, `#47566e` | `--plane-status-good`, `--plane-status-neutral` |

### `src/pages/FontesPage.tsx`

| linha (antes) | literais | vira |
|---|---|---|
| 157 | `#4b4b52` | `--text-muted` |

### `src/pages/HistoricoPage.css`

| linha (antes) | literais | vira |
|---|---|---|
| 108 | `#ccd2db`, `#fff` | `--plane-input-border-color`, `--plane-input-bg` |
| 129 | `rgba(255, 255, 255, 0.7)`, `rgba(58, 61, 70, 0.08)` | `--glass-divider-bg`, `--glass-divider-shadow` |
| 183 | `#e9ecf0` | `--plane-divider-color` |
| 192 | `#f7f8fa` | `--plane-surface-sunken` |
| 278 | `#5b4d88` | `--text-violet-quiet` |

### `src/pages/LoginPage.css`

| linha (antes) | literais | vira |
|---|---|---|
| 51 | `#08060d` | `--text-strong` |
| 76 | `rgba(255, 255, 255, 0.55)` | `--login-frame-bg` |
| 79 | `rgba(255, 255, 255, 0.7)`, `rgba(15, 15, 20, 0.1)` | `--login-frame-border-color`, `--login-frame-shadow` |
| 89 | `rgba(91, 141, 251, 0.35)`, `rgba(163, 91, 251, 0.22)` | `--login-frame-glow` |
| 107 | `rgba(255, 255, 255, 0.7)`, `rgba(58, 61, 70, 0.08)` | `--glass-divider-bg`, `--glass-divider-shadow` |
| 120 | `rgba(255, 255, 255, 0.66)`, `rgba(255, 255, 255, 0.86)` | `--glass-tile-bg`, `--glass-inner-border-color` |
| 201 | `#d9dfe9`, `#ffffff` | `--plane-border-color`, `--plane-input-bg` |

### `src/pages/LoginPage.tsx`

| linha (antes) | literais | vira |
|---|---|---|
| 18 | `#8b5a08`, `#176945`, `#a32a24` | `--plane-status-warn`, `--plane-status-good`, `--plane-status-danger` |

### `src/pages/RegrasPage.css`

| linha (antes) | literais | vira |
|---|---|---|
| 79 | `#f7f8fa`, `#e9ecf0` | `--plane-surface-sunken`, `--plane-divider-color` |
| 88 | `#e9ecf0` | `--plane-divider-color` |
| 111 | `#f5f7fa` | `--plane-row-highlight` |
| 259 | `#ccd2db`, `#fff` | `--plane-input-border-color`, `--plane-input-bg` |
| 276 | `#6b7280` | `--plane-text-placeholder` |
| 353 | `#e9ecf0` | `--plane-divider-color` |

### `src/pages/SaudePage.css`

| linha (antes) | literais | vira |
|---|---|---|
| 130 | `#f7f8fa`, `#e9ecf0` | `--plane-surface-sunken`, `--plane-divider-color` |
| 163 | `#ccd2db`, `#fff` | `--plane-input-border-color`, `--plane-input-bg` |
| 184 | `#e9ecf0` | `--plane-disabled-bg` |
| 193 | `#eef2f7`, `#dde3ec` | `--plane-tint-bg`, `--plane-tint-border-color` |

### `src/pages/SaudePage.tsx`

| linha (antes) | literais | vira |
|---|---|---|
| 30 | `#8a6d00`, `#1c8a4b`, `#b3261e` | `--pill-warn-dot`, `--pill-good-dot`, `--pill-danger-dot` |
| 173 | `#176945` | `--plane-status-good` |
