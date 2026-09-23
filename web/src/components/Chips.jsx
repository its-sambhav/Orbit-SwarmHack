import { useLanguage } from '../i18n'

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

// only the 3 most common finding tags get an identity colour (validated
// all-pairs categorical set, see tokens.css) - every other tag (DATA
// INTEGRITY, DUPLICATION, OVER ALLOCATION, all rare) keeps the neutral
// outline rather than stretching a 3-colour set past what's been validated.
// The colour lookup stays keyed by the engine's own English tag string (the
// only stable identity the pipeline emits); only the visible text is
// translated, so a language switch never changes which tag reads as which
// colour.
export const TAG_COLOR_KEY = {
  'GHOST ASSET': 'ghost-asset',
  'COST OUTLIER': 'cost-outlier',
  'TIME DELAY': 'time-delay',
}

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

export function SuppressedChip() {
  const { t } = useLanguage()
  return <span className="chip suppressed-chip">{t('Suppressed — calamity consent on record')}</span>
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
