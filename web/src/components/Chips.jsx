export const SEV_LABEL = { low: 'Low', medium: 'Medium', high: 'High' }

export function SeverityChip({ severity }) {
  if (!severity) return null
  return (
    <span
      className="chip severity-chip"
      style={{ background: `var(--sev-${severity}-bg)`, color: `var(--sev-${severity})` }}
    >
      {SEV_LABEL[severity] || severity}
    </span>
  )
}

export function TagChip({ tag }) {
  return <span className="chip tag-chip">{tag}</span>
}

export function SuppressedChip() {
  return <span className="chip suppressed-chip">Suppressed — calamity consent on record</span>
}
