import { DEMO_INSTALL_URL, DEMO_REPO_URL } from './links'

/** S24-01: the static demo's links, inside the phone "Mais" sheet. */
export function DemoStaticLinks() {
  return (
    <>
      {' '}
      <a href={DEMO_REPO_URL} target="_blank" rel="noreferrer">
        Ver o código no GitHub
      </a>
      {' · '}
      <a href={DEMO_INSTALL_URL} target="_blank" rel="noreferrer">
        Instalar o seu
      </a>
    </>
  )
}
