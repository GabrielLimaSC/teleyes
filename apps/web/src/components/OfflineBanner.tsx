import { useEffect, useState } from 'react'
import './OfflineBanner.css'

/** S24-02a (11): server unreachable (SSE dropped). The list already loaded stays. */
export function ConnectionLostNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="connection-lost" role="status">
      <p className="connection-lost__title">Sem conexão com o servidor</p>
      <p className="connection-lost__text">Mostrando as ofertas já carregadas. Tentando de novo em instantes.</p>
      <button type="button" className="plane-action plane-action--secondary connection-lost__retry" onClick={onRetry}>
        Tentar agora
      </button>
    </div>
  )
}

export function OfflineBanner() {
  const [offline, setOffline] = useState(() => !navigator.onLine)

  useEffect(() => {
    const goOffline = () => setOffline(true)
    const goOnline = () => setOffline(false)
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [])

  if (!offline) return null

  return (
    <div className="offline-banner" role="status">
      Você está offline — os dados na tela podem estar desatualizados.
    </div>
  )
}
