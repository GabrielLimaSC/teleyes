import './DemoStaticStrip.css'
import { DEMO_INSTALL_URL, DEMO_REPO_URL } from './links'

/** The fixed strip of the public static demo: says it is fictional and points to the code. */
export function DemoStaticStrip() {
  return (
    <div className="demo-banner demo-banner--static" role="note" aria-label="Aviso de modo demonstração">
      <span>Demonstração — dados fictícios, nada é salvo</span>
      <span className="demo-banner__links">
        <a href={DEMO_REPO_URL} target="_blank" rel="noreferrer">
          Ver o código no GitHub
        </a>
        <a href={DEMO_INSTALL_URL} target="_blank" rel="noreferrer">
          Instalar o seu
        </a>
      </span>
    </div>
  )
}
