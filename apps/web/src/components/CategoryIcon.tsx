import type { MatchCategory } from './matchCategory'

const PATHS: Record<MatchCategory, string> = {
  phone: 'M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm4 17h.01',
  laptop: 'M4 5h16v10H4V5Zm-2 13h20l-2 3H4l-2-3Z',
  headphones: 'M4 13v-1a8 8 0 0 1 16 0v1M4 13a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h1v-6H4Zm16 0a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1v-6h1Z',
  gaming: 'M6 9h12a4 4 0 0 1 4 4l-1 6a2 2 0 0 1-3.6 1.2L15 17H9l-2.4 3.2A2 2 0 0 1 3 19l-1-6a4 4 0 0 1 4-4Zm2 3v3m1.5-1.5h-3M16 12h.01M18.5 14.5h.01',
  generic: 'M20.6 12.3 12.3 20.6a2 2 0 0 1-2.8 0l-6.1-6.1a2 2 0 0 1 0-2.8L11.7 3.4A2 2 0 0 1 13.1 3H19a2 2 0 0 1 2 2v5.9a2 2 0 0 1-.4 1.4ZM16 8h.01',
}

export function CategoryIcon({ category }: { category: MatchCategory }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[category]} />
    </svg>
  )
}
