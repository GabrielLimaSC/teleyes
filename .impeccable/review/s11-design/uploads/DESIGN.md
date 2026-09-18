---
name: teleyes
description: Console Operate com navegação Liquid Glass e conteúdo de leitura estável. Proposta S10-05 sujeita à escolha de Gabriel.
colors:
  canvas: "#f5f5f7"
  surface: "#ffffff"
  surface-end: "#fcfdff"
  surface-hover: "#f5f7fa"
  surface-muted: "#f7f8fa"
  surface-border: "#d9dfe9"
  input-border: "#ccd2db"
  divider: "#e9ecf0"
  ink: "#171717"
  ink-strong: "#0a0a0a"
  ink-muted: "#525866"
  ink-soft: "#606875"
  placeholder: "#6b7280"
  action: "#171717"
  focus: "#315ea8"
  focus-ring: "rgba(49, 94, 168, 0.16)"
  glass-tint: "rgba(232, 234, 239, 0.42)"
  glass-tint-low: "rgba(212, 216, 224, 0.65)"
  glass-badge-low: "rgba(213, 216, 225, 0.75)"
  glass-shade: "rgba(58, 61, 70, 0.18)"
  glass-edge: "rgba(255, 255, 255, 0.84)"
  category-phone-ink: "#415d89"
  category-laptop-ink: "#655082"
  category-audio-ink: "#926346"
  lowest-border: "#bbc9df"
  lowest-ink: "#5b4d88"
  login-shadow-ink: "rgba(28, 37, 50, 0.07)"
  success: "#176945"
  success-bg: "#e8f5ec"
  warning: "#8b5a08"
  warning-bg: "#fff2dc"
  neutral-status: "#47566e"
  neutral-status-bg: "#eef2f7"
  danger: "#a32a24"
  danger-bg: "#fbe9e7"
typography:
  family: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
  page-title: "700 30px/1.14"
  section-title: "700 18px/1.3"
  item-title: "700 16px/1.45"
  body: "400 14px/1.5"
  label: "600 13px/1.4"
  metadata: "400 12px/1.5"
rounded:
  nav: "999px"
  panel: "16px"
  login-panel: "20px"
  category-tile: "12px"
  control: "10px"
  small-control: "8px"
  status: "999px"
spacing:
  unit: "4px"
  page-inline-desktop: "24px"
  page-inline-mobile: "16px"
  panel-padding: "24px"
  panel-padding-mobile: "18px"
  section-gap: "28px"
shadows:
  nav: "0 18px 32px rgba(23, 23, 23, 0.13), 0 4px 10px rgba(23, 23, 23, 0.09)"
  panel: "0 5px 18px rgba(23, 23, 23, 0.035)"
  action: "0 3px 8px rgba(23, 23, 23, 0.13)"
  login: "0 16px 40px rgba(28, 37, 50, 0.07)"
---

# Sistema visual proposto — S10-05

**Status: conceito para escolha do Gabriel; este documento especifica o estado-alvo, não descreve o CSS já entregue.**
Nenhum estilo desta proposta deve ser aplicado a todas as páginas antes dessa escolha. Os comps usam
conteúdo ilustrativo identificado na imagem; não representam conexão, entregas, preços ou métricas reais.

## Decisão de material

A [Apple HIG — Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
separa Liquid Glass (camada funcional que flutua sobre o conteúdo) de materiais padrão (estrutura *dentro*
do conteúdo). Ela recomenda vidro líquido para navegação, barras, popovers e controles transitórios, e
pede parcimônia: vidro no conteúdo denso prejudica a hierarquia e a leitura. A
[orientação de adoção](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass)
reforça contraste, configurações de transparência/movimento e legibilidade ao rolar sob controles.
Aplicamos **esse critério de função** ao React/CSS web, sem presumir que os componentes nativos da Apple
existam no navegador. Não se trata de copiar a aparência de um sistema operacional.

| Plano | Elementos | Material alvo | Motivo |
| --- | --- | --- | --- |
| 1, conteúdo | Fundo, listas, cartões de match, tabelas, formulários, campos e painéis de Saúde | Branco/perolado estável, sem `backdrop-filter` nem refração | Leitura de texto, preços e dados não varia com o fundo que passa atrás. |
| 2, ação contextual | Botões, toggles, filtros, menus internos | Opacos, com o mesmo vocabulário de cor/canto/foco; superfície de menu *flutuante* pode usar vidro regular | A ação precisa ser encontrada; a superfície do formulário não precisa flutuar. |
| 3, navegação/overlay | `NavCapsule` e drawer; tooltip, toast e popover quando realmente sobrepostos | Vidro regular: blur, tint prateado, borda iluminada; refração SVG **só na navbar** | Marca o plano funcional superior. Overlay espesso o bastante para leitura. |

**Proibição de empilhamento:** não aplicar `glass-card` com blur em MatchCard, tabela, formulário, login
ou Saúde se outro elemento de vidro estiver acima. A classe atual `glass-card` é um fato do código antes
da migração, não uma autorização para replicá-la na camada de conteúdo. Migrar por componente numa task
do Dev, mantendo o mesmo markup e comportamento. Não criar um segundo sistema de tokens paralelo ao
`styles/tokens.css`; revisar os valores existentes nesse arquivo depois da aprovação.

## Tokens-alvo e como usá-los

- **Base:** canvas `#f5f5f7` com wash radial já existente, reduzido a no máximo 0,12 de opacidade
  por canal; superfície de leitura `linear-gradient(165deg, #ffffff 0%, #fcfdff 100%)`. Borda perolada
  `#d9dfe9`, divisão interna `#e9ecf0`, cabeçalho de tabela `#f7f8fa`, hover de linha `#f5f7fa`.
  Não usar vidro/blur para fabricar contraste de campo ou célula.
- **Texto:** Inter já carregada em `--font-body`. Título 30/700; seção 18/700; nome do item e preço
  16–18/700; corpo 14/400; label 13/600; metadado 12/400. Tinta principal `#171717`, preço e dados
  decisivos `#0a0a0a`; apoio `#525866`, metadado mais fraco `#606875` apenas em fundo branco/perolado.
  Evitar cinza `#8a8a92` para informação necessária. Numerais de preço e tabela com
  `font-variant-numeric: tabular-nums`.
- **Forma:** navbar e status em pill; painel 16px (login isolado 20px); campos e botões comuns 10px;
  botões compactos de tabela 8px; tile de categoria 12px. Cantos concêntricos: elemento interno menor
  que o container. Não repetir o raio pill em todos os botões e campos.
- **Profundidade:** navbar mantém sua sombra atual de dois níveis e borda branca; painéis de conteúdo
  usam borda 1px `#d9dfe9` e sombra quase imperceptível `0 5px 18px rgba(23,23,23,.035)`;
  login isolado `0 16px 40px rgba(28,37,50,.07)`; botão primário `0 3px 8px rgba(23,23,23,.13)`.
  Sem halo colorido permanente. Aurora Glow fica restrita ao menor preço **quando o backend confirmar**.
- **Ação:** primário `#171717`/branco, 10px de raio, altura mínima 40px; secundário branco com borda
  `#d9dfe9`; destrutivo mantém texto explícito `Excluir` em `#a32a24` e confirmação própria.
  Hover primário `#303030`, secundário `#f5f7fa`; pressed `#eceff4` ou `#0a0a0a` conforme variante.
  A animação breve de `FillButton` pode permanecer na ação primária, respeitando movimento reduzido.
- **Campos:** branco, borda `#ccd2db`, raio 10px, altura mínima 42px e label visível acima. `:hover`
  borda `#aab5c5`; `:focus-visible` borda `#315ea8` e anel externo de 3px
  `rgba(49,94,168,.16)` sem remover outline equivalente; erro com texto e `#a32a24`, não só vermelho.
  Placeholder `#6b7280`, nunca única descrição. Select usa o mesmo campo e chevron SVG de traço 2px
  em `#525866`; chevron aponta para baixo e acompanha foco/disabled. Sem emoji/Unicode como ícone.
- **Estados:** linha de tabela `:hover` `#f5f7fa` na linha inteira, nunca numa coluna solta; links
  sublinhados com `text-underline-offset: 3px`; botões com foco de 3px `#315ea8`/offset 2px;
  disabled opaco `#e9ecf0` e texto `#606875`; loading mantém largura e rótulo de ação; toggles têm
  estado textual ativo/pausado ao lado do indicador. Ícones SVG têm uma família de traço de 1,75–2px,
  16px em botões e 20–24px em tiles; setas de navegação herdam `currentColor` e nunca substituem
  rótulos. Status sempre inclui **ponto + palavra**.
- **Status:** sucesso `#176945`/`#e8f5ec`; atenção `#8b5a08`/`#fff2dc`; pausado/inativo
  `#47566e`/`#eef2f7`; erro `#a32a24`/`#fbe9e7`. Reservar azul `#315ea8` para foco/link e
  violeta/aurora somente para menor preço confirmado. Cor não é o único sinal.
- **Categoria e menor preço:** tiles de categoria de 12px e cor sempre cosmética; ícones de telefone
  `#415d89`, laptop `#655082`, áudio `#926346`. O menor preço real pode receber borda `#bbc9df` e
  legenda `#5b4d88`; o exemplo dos comps demonstra essa condição e não afirma que ocorreu no app.

## Auditoria e decisões por tela

| Tela / elemento real | Estado observado em `origin/dev` | Conceito proposto |
| --- | --- | --- |
| Login: card, campo, botão, mascote | `.glass-card` 60%/blur 20px; input translúcido; botão pill | Card branco estável com borda perolada e sombra isolada. Campo e CTA opacos; foco azul. Mascote conserva imagem e badge; sem nova informação de produto. |
| Feed: `MatchCard`, lista, atualização, preço/status | Card com `.glass-card`; atualização cinza; preço e metadados com cores hardcoded | Linha perolada sem blur; produto/preço escuros, meta discreta, link sublinhado; tile pastel e status ponto+palavra. `Atualizar` é secundário. Aurora só para menor preço real. |
| Histórico: filtros, lista de matches | Filtros misturam raio 10, pill e fundo branco; usa MatchCard | Mesma linha do Feed. Filtros opacos 10px, labels acima, select com chevron coerente; resultado/erro/empty state textuais. |
| Regras: formulário, tabela, toggle, ações, teste | `.glass-card` em formulário e tabela; tokens Dub 12/8/6px; linha com divisor cinza | Formulário e tabela perolados 16px; campos/CTA 10px, ações da linha 8px. Hover percorre a linha inteira; foco igual ao Login; status/toggle textual. Teste inline estável, sem vidro. |
| Destinatários (seção de Regras) | Mesmo `CrudTable` e `glass-card`; ações compactas | Herdar exatamente a tabela de Regras: mesma densidade, cabeçalho, hover, ação e estado. Nenhum material novo. |
| Fontes: cadastro e tabela | Reutiliza `CrudTable`, `StatusToggle`; instrução inline hardcoded | Mesma regra de Regras. `Chat ID` usa dígitos tabulares; texto de ajuda `#525866`; nenhum botão especial por ser fonte. |
| Saúde: estados, valores e teste de notificação | Dois `.glass-card`; inputs da S9-01; resultado/erro textuais | Painéis perolados de leitura, separadores finos; estado ponto+palavra; formulário opaco com chevron e foco compartilhados. Não transformar indicadores em vidro. |
| Navegação, toast, tooltip, offline banner | Navbar refrativa; toast/tooltip usam `.glass-card`; banner opaco | Manter navbar da S9-03/S9-05. Toast/tooltip são overlays temporários de vidro regular com tint mais opaco para leitura; banner de erro/sem rede opaco por urgência e contraste. |

## Layout, responsividade e acessibilidade

- Navbar atual: 720px máximo, 68px alto no desktop; 64px no móvel com drawer, sem mudar sua função.
  Conteúdo: Feed/Histórico 760–820px, Saúde 640–760px, CRUD até 1120px; margens laterais de 24px
  no desktop e 16px a 400px. Formulários mudam de duas colunas para uma até 760px; tabela densa
  vira linhas empilhadas rotuladas até 640px, mantendo ações visíveis sem scroll da página.
- Uma superfície de leitura não deve depender da cor do wash de fundo para ter contraste. Testar texto
  normal e placeholder >=4,5:1, títulos grandes >=3:1, foco visível por teclado, zoom 200%, largura
  de 400px, dados longos, vazio, erro e carregamento. Não encurtar nome de produto no meio de palavra.
- `prefers-reduced-motion: reduce`: retirar transições de drawer, fill, hover e tooltip. Com transparência
  reduzida ou falta de `backdrop-filter`, navbar/overlays viram prateado opaco `#eef0f4` com texto
  `#171717`; conteúdo já é opaco. A camada funcional não pode esconder texto ao rolar.

## Comps reproduzíveis

Fonte estática: `.impeccable/review/s10-05-concept.html`. PNGs em desktop:
[Login](.impeccable/review/s10-05-login.png),
[Feed](.impeccable/review/s10-05-feed.png),
[Regras](.impeccable/review/s10-05-regras.png),
[Saúde](.impeccable/review/s10-05-saude.png); em 400px:
[Feed](.impeccable/review/s10-05-feed-mobile.png) e
[Regras](.impeccable/review/s10-05-regras-mobile.png).
O HTML é um artefato de decisão, não uma nova rota nem implementação da UI. A navbar da imagem aproxima
a existente para contextualizar; o componente real permanece na S9-03/S9-05. Alguns rótulos da
composição ajudam a mostrar hierarquia e devem ser conferidos pelo Dev contra a cópia atual antes do
rollout. Após a escolha do Gabriel, criar uma task do Dev para migrar os CSS e componentes, com teste
visual nas seis páginas e estados. Até lá, a diferença entre CSS atual e esta especificação é esperada.
