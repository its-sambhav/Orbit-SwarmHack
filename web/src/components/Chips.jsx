import { useLanguage } from '../i18n'
import { TAGS } from '../tags'

export const SEV_LABEL = { low: 'Low', medium: 'Medium', high: 'High' }

export function SeverityChip({ severity }) {
  const { t } = useLanguage()
  if (!severity) return null
  return (
    <span
      className="chip severity-chip"
      style={{ background: `var(--sev-${severity}-bg)`, color: `var(--sev-${severity})` }}
    >
      {t(SEV_LABEL[severity] || severity)}
    </span>
  )
}

// Colour by tag FAMILY (config/tags.yaml), using the one validated 3-colour
// categorical set in tokens.css: timing, money and documentation each get
// one identity colour; guideline, concentration and data-integrity tags keep
// the neutral outline rather than stretching the set past what's validated.
// Keyed by the engine's own English tag name; only the visible text is
// translated, so a language switch never changes a tag's colour.
const FAMILY_COLOR = { timing: 'time-delay', money: 'cost-outlier', documentation: 'ghost-asset' }
export const TAG_COLOR_KEY = Object.fromEntries(
  TAGS.filter((t) => FAMILY_COLOR[t.family]).map((t) => [t.name, FAMILY_COLOR[t.family]]),
)

export function TagChip({ tag }) {
  const { t } = useLanguage()
  const key = TAG_COLOR_KEY[tag]
  if (!key) return <span className="chip tag-chip">{t(tag)}</span>
  return (
    <span className="chip tag-chip-colored" style={{ background: `var(--tag-${key}-bg)`, color: `var(--tag-${key})` }}>
      {t(tag)}
    </span>
  )
}

// suppression now comes from reviewer feedback (engine/validation.py) - the
// reason says which pattern reviewers kept dismissing
export function SuppressedChip({ reason }) {
  const { t, td } = useLanguage()
  return <span className="chip suppressed-chip" title={reason ? td(reason) : undefined}>{t('Suppressed')}</span>
}

// the work's portal lifecycle stage ("Pending for Sanction", "Work Completed", ...)
export function StageChip({ stage }) {
  const { t } = useLanguage()
  if (!stage) return null
  return <span className="chip tag-chip">{t(stage)}</span>
}

// MP status - "Active" (currently serving) gets the institutional-gold
// official-marker treatment; "Former" stays neutral.
export function StatusChip({ status }) {
  const { t } = useLanguage()
  if (status !== 'Active') return <span className="chip tag-chip">{t(status)}</span>
  return (
    <span className="chip tag-chip-colored" style={{ background: 'var(--gold-wash)', color: 'var(--gold)' }}>
      {t(status)}
    </span>
  )
}

// bands an MP's flagged-work rate onto the same amber->red ramp severity
// chips use - the MP-level analogue of a finding's severity, not a new use
// of the tag-identity colours.
function riskBand(rate) {
  if (rate == null) return null
  if (rate < 0.2) return 'low'
  if (rate < 0.45) return 'medium'
  return 'high'
}

export function RiskChip({ rate }) {
  const band = riskBand(rate)
  if (!band) return <span className="num">—</span>
  return (
    <span className="chip" style={{ background: `var(--sev-${band}-bg)`, color: `var(--sev-${band})`, fontWeight: 700 }}>
      {(rate * 100).toFixed(0)}%
    </span>
  )
}
