import { useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { addTerms, parseTermList, removeTerm } from '../utils/termList'
import './TermChipsInput.css'

interface TermChipsInputProps {
  id: string
  label: string
  /** Stored format: the same comma-separated string the API takes. */
  value: string
  onChange: (value: string) => void
  helper?: string
}

/**
 * S11-05: include terms as chips. Enter or a comma turns the typed text into
 * a chip; Backspace on an empty field removes the last one; leaving the field
 * commits whatever is still typed, so clicking "Criar regra" right after the
 * last term never loses it. The value stays the API's comma-separated string
 * — chips are only how it is edited.
 */
export function TermChipsInput({ id, label, value, onChange, helper }: TermChipsInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const terms = parseTermList(value)

  const commitDraft = () => {
    if (draft.trim() === '') {
      setDraft('')
      return
    }
    onChange(addTerms(value, draft))
    setDraft('')
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const typed = event.target.value
    if (!typed.includes(',')) {
      setDraft(typed)
      return
    }
    // A comma (typed or pasted in a list) closes every segment before it;
    // only the text after the last comma stays as the draft.
    const lastComma = typed.lastIndexOf(',')
    onChange(addTerms(value, typed.slice(0, lastComma)))
    setDraft(typed.slice(lastComma + 1))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && draft.trim() !== '') {
      // Adds the chip instead of submitting the form; an empty field lets
      // Enter submit as usual.
      event.preventDefault()
      commitDraft()
      return
    }
    if (event.key === 'Backspace' && draft === '' && terms.length > 0) {
      onChange(removeTerm(value, terms[terms.length - 1]))
    }
  }

  return (
    <div className="term-chips-field">
      <label htmlFor={id}>{label}</label>
      {/* Clicking the empty area of the box focuses the field, like a
          plain input — the box is the visual input, the <input> inside is
          the real one. */}
      <div className="term-chips" onClick={() => inputRef.current?.focus()}>
        {terms.map((term) => (
          <span key={term.toLowerCase()} className="term-chips__chip">
            {term}
            <button
              type="button"
              className="term-chips__remove"
              aria-label={`Remover termo ${term}`}
              onClick={(event) => {
                event.stopPropagation()
                onChange(removeTerm(value, term))
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          className="term-chips__input"
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={commitDraft}
          placeholder={terms.length === 0 ? 'ex.: rtx 5070' : 'adicionar…'}
          autoComplete="off"
        />
      </div>
      {helper && <span className="term-chips-field__helper">{helper}</span>}
    </div>
  )
}
