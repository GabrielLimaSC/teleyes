import { useState } from 'react'
import type { FormEvent } from 'react'
import { CSRF_MISSING_MESSAGE } from '../auth/AuthContext'
import { saveCredentials } from '../api/setup'
import { useFillOrigin } from '../utils/useFillOrigin'
import { errorMessage } from './timers'
import type { StepProps } from './types'
import { validateApiHash, validateApiId } from './validation'

/** Step 1: the Telegram app credentials (api_id / api_hash). */
export function CredentialsStep({ status, csrfToken, onStatus }: StepProps) {
  const fillOrigin = useFillOrigin()
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const sessionExists = status.login.state === 'authorized'

  if (status.credentials.source === 'env') {
    return (
      <p className="setup-note">
        O api_id e o api_hash já estão definidos no arquivo <code>.env</code> deste computador e têm
        prioridade. Para trocá-los, edite o <code>.env</code>.
      </p>
    )
  }

  if (status.credentials.configured && !editing) {
    return (
      <div className="setup-stack">
        <p className="setup-note">
          O api_id e o api_hash estão salvos neste computador. O api_hash nunca é mostrado de novo.
        </p>
        <div className="setup-actions">
          <button
            type="button"
            className="plane-action plane-action--secondary setup-button"
            onClick={() => setEditing(true)}
            disabled={sessionExists}
          >
            Trocar credenciais
          </button>
          {sessionExists && (
            <span className="setup-hint">Desconecte o Telegram (passo 2) para trocar as credenciais.</span>
          )}
        </div>
      </div>
    )
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const problem = validateApiId(apiId) ?? validateApiHash(apiHash)
    if (problem !== null) {
      setError(problem)
      return
    }
    if (csrfToken === null) {
      setError(CSRF_MISSING_MESSAGE)
      return
    }
    setSaving(true)
    setError(null)
    saveCredentials(csrfToken, Number(apiId.trim()), apiHash.trim())
      .then((next) => {
        setApiId('')
        setApiHash('')
        setEditing(false)
        onStatus(next)
      })
      .catch((failure: unknown) => setError(errorMessage(failure, 'Não foi possível salvar as credenciais.')))
      .finally(() => setSaving(false))
  }

  return (
    <form className="setup-stack" onSubmit={submit} noValidate>
      <p className="setup-note">
        O teleyes lê o Telegram como um aplicativo seu. Para isso o Telegram precisa te dar um{' '}
        <strong>api_id</strong> e um <strong>api_hash</strong> (é de graça e leva 2 minutos):
      </p>
      <ol className="setup-steps-list">
        <li>
          Abra{' '}
          <a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer">
            my.telegram.org/apps
          </a>{' '}
          e entre com o número da conta que vai ler os grupos.
        </li>
        <li>
          Em <em>API development tools</em>, crie um aplicativo (nome e apelido livres; a plataforma pode ser{' '}
          <em>Desktop</em>).
        </li>
        <li>
          Copie o <strong>App api_id</strong> e o <strong>App api_hash</strong> para os campos abaixo.
        </li>
      </ol>
      <div className="setup-fields">
        <label className="setup-field">
          api_id
          <input
            value={apiId}
            onChange={(event) => setApiId(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="1234567"
          />
        </label>
        <label className="setup-field">
          api_hash
          <input
            type="password"
            value={apiHash}
            onChange={(event) => setApiHash(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            placeholder="32 caracteres"
          />
        </label>
      </div>
      <p className="setup-hint">
        Ficam guardados só neste computador, em arquivo privado (permissão 0600), fora dos backups do banco.
      </p>
      {error !== null && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
      <div className="setup-actions">
        <button
          type="submit"
          className="plane-action fill-button setup-button"
          onPointerDown={fillOrigin}
          disabled={saving}
        >
          {saving ? 'Salvando…' : 'Salvar credenciais'}
        </button>
        {editing && (
          <button
            type="button"
            className="plane-action plane-action--secondary setup-button"
            onClick={() => setEditing(false)}
          >
            Cancelar
          </button>
        )}
      </div>
    </form>
  )
}
