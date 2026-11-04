/**
 * S23-01: CSV field encoding for the history export.
 *
 * Product titles and links come from Telegram messages, i.e. from strangers. A cell that
 * starts with `=`, `+`, `-`, `@`, a tab or a carriage return is read as a formula by
 * Excel, Sheets and LibreOffice (CSV injection), so such a cell is prefixed with `'`,
 * which the spreadsheet shows as plain text.
 */
const FORMULA_START = /^[=+\-@\t\r]/

export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value
}

export function csvField(value: string): string {
  const safe = neutralizeFormula(value)
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`
  return safe
}
