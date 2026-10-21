import { useEffect, useState } from 'react'
import { fetchHealth } from '../api/health'
import { DEMO_BANNER_TEXT, DEMO_READONLY_MESSAGE, onDemoReadOnly } from '../api/demo'
import { useToast } from '../hooks/useToast'
import { Toast } from './Toast'
import './DemoBanner.css'

/**
 * S19-03: on every page, login included, when the API says it runs in demo mode
 * (`GET /health` is public). Also the one place that turns a rejected write
 * ("Modo demonstração: alterações desativadas.") into the existing toast, so no
 * page needs to know about demo mode to degrade gracefully.
 */
export function DemoBanner() {
  const [demo, setDemo] = useState(false)
  const { toast, showToast, dismiss } = useToast()

  useEffect(() => {
    let cancelled = false
    fetchHealth()
      .then((health) => {
        if (!cancelled) setDemo(health.demo === true)
      })
      .catch(() => {
        /* sem saúde, sem aviso: nunca inventa um estado */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (demo) document.documentElement.dataset.demo = 'true'
    else delete document.documentElement.dataset.demo
    return () => {
      delete document.documentElement.dataset.demo
    }
  }, [demo])

  useEffect(() => onDemoReadOnly(() => showToast(DEMO_READONLY_MESSAGE, 'error')), [showToast])

  return (
    <>
      {demo && (
        <div className="demo-banner" role="note" aria-label="Aviso de modo demonstração">
          {DEMO_BANNER_TEXT}
        </div>
      )}
      <Toast toast={toast} onDismiss={dismiss} />
    </>
  )
}
