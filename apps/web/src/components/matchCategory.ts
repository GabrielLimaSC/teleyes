export type MatchCategory = 'phone' | 'laptop' | 'headphones' | 'gaming' | 'generic'

const CATEGORY_KEYWORDS: Record<Exclude<MatchCategory, 'generic'>, string[]> = {
  phone: ['iphone', 'celular', 'smartphone', 'galaxy', 'xiaomi', 'motorola', 'redmi'],
  laptop: ['notebook', 'laptop', 'macbook', 'ultrabook', 'chromebook'],
  headphones: ['fone', 'headset', 'earbud', 'airpod', 'headphone'],
  gaming: ['playstation', 'ps5', 'ps4', 'xbox', 'nintendo', 'switch', 'controle', 'console'],
}

/**
 * `Match` has no category field (packages/events/broker.py's payload and
 * `MatchResponse` don't carry one) — this is a client-side, purely cosmetic
 * heuristic over `message_text` for the category icon/color described in
 * docs/SPRINT4_DIRECTION.md. It never drives matching, dedupe, or anything
 * that affects real data — only which icon and soft background color a card
 * gets.
 */
export function categorize(messageText: string): MatchCategory {
  const normalized = messageText.toLowerCase()
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as [
    Exclude<MatchCategory, 'generic'>,
    string[],
  ][]) {
    if (keywords.some((keyword) => normalized.includes(keyword))) return category
  }
  return 'generic'
}

export const CATEGORY_BACKGROUND: Record<MatchCategory, string> = {
  phone: 'var(--category-phone-bg)',
  laptop: 'var(--category-laptop-bg)',
  headphones: 'var(--category-headphones-bg)',
  gaming: 'var(--category-gaming-bg)',
  generic: 'var(--category-generic-bg)',
}

/** Stroke color of the category icon (`currentColor` in CategoryIcon). */
export const CATEGORY_ICON_COLOR: Record<MatchCategory, string> = {
  phone: 'var(--category-phone-icon)',
  laptop: 'var(--category-laptop-icon)',
  headphones: 'var(--category-headphones-icon)',
  gaming: 'var(--category-gaming-icon)',
  generic: 'var(--category-generic-icon)',
}
