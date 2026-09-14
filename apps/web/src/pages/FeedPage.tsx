import { useEffect, useState } from 'react'
import { MatchCard } from '../components/MatchCard'
import { fetchRecipients, fetchRules, fetchSources } from '../api/lookups'
import { useLiveMatches } from '../hooks/useLiveMatches'
import type { Recipient, Rule, Source } from '../api/types'
import './FeedPage.css'

export function FeedPage() {
  const { matches, loading, error, connectionState, refresh } = useLiveMatches()
  const [rules, setRules] = useState<Rule[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [recipients, setRecipients] = useState<Recipient[]>([])

  useEffect(() => {
    fetchRules().then(setRules).catch(() => setRules([]))
    fetchSources().then(setSources).catch(() => setSources([]))
    fetchRecipients().then(setRecipients).catch(() => setRecipients([]))
  }, [])

  return (
    <main className="feed-page">
      <div className="feed-page__header">
        <div>
          <h1>Feed ao vivo</h1>
          <p className="feed-page__subtitle">Ofertas encontradas pelas suas regras, em tempo real.</p>
        </div>
        <button type="button" className="feed-page__refresh" onClick={refresh}>
          Atualizar
        </button>
      </div>
      {connectionState === 'error' && (
        <p className="feed-page__connection-warning" role="status">
          Conexão com o feed caiu — tentando reconectar…
        </p>
      )}
      {loading && <p>Carregando…</p>}
      {error && (
        <p role="alert" className="feed-page__error">
          {error}
        </p>
      )}
      {!loading && !error && matches.length === 0 && <p>Nenhum match ainda.</p>}
      <div className="feed-page__list">
        {matches.map((match) => (
          <MatchCard
            key={match.id}
            match={match}
            rule={rules.find((rule) => rule.id === match.rule_id)}
            source={sources.find((source) => source.id === match.source_id)}
            recipients={recipients}
          />
        ))}
      </div>
    </main>
  )
}
