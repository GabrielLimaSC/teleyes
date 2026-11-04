/**
 * S23-05: starting points for a new rule. Generic product categories only —
 * no store or group names. Each template fills the name, the include terms
 * (comma-separated; `a + b` requires both words) and the usual block list,
 * and leaves the price ceiling empty on purpose: that is the one thing only
 * the user knows.
 */
export interface RuleTemplate {
  id: string
  label: string
  name: string
  includeTerms: string
  excludeTerms: string
}

const USED = 'usado, seminovo, recondicionado, caixa aberta'

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    id: 'gpu',
    label: 'Placa de vídeo',
    name: 'Placa de vídeo',
    includeTerms: 'placa de video, rtx, rx',
    excludeTerms: `${USED}, suporte, cabo`,
  },
  {
    id: 'cpu',
    label: 'Processador',
    name: 'Processador',
    includeTerms: 'processador, ryzen, core i5, core i7',
    excludeTerms: `${USED}, notebook`,
  },
  {
    id: 'ram',
    label: 'Memória RAM',
    name: 'Memória RAM',
    includeTerms: 'memoria ram + 16gb, memoria ram + 32gb',
    excludeTerms: `${USED}, notebook`,
  },
  {
    id: 'ssd',
    label: 'SSD',
    name: 'SSD',
    includeTerms: 'ssd + 1tb',
    excludeTerms: `${USED}, externo, case`,
  },
  {
    id: 'monitor',
    label: 'Monitor',
    name: 'Monitor',
    includeTerms: 'monitor + 27, monitor + 144hz',
    excludeTerms: `${USED}, suporte`,
  },
  {
    id: 'notebook',
    label: 'Notebook',
    name: 'Notebook',
    includeTerms: 'notebook + 16gb, notebook gamer',
    excludeTerms: `${USED}, capa, suporte`,
  },
  {
    id: 'phone',
    label: 'Celular',
    name: 'Celular',
    includeTerms: 'celular, smartphone',
    excludeTerms: `${USED}, capa, pelicula`,
  },
  {
    id: 'headphone',
    label: 'Fone de ouvido',
    name: 'Fone de ouvido',
    includeTerms: 'fone de ouvido, headset, fone bluetooth',
    excludeTerms: `${USED}, capa, suporte`,
  },
]
