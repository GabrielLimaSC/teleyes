import { useEffect, useState } from 'react'
import './OfflineBanner.css'

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
