import { formatRupees } from '../api'
import { useLanguage } from '../i18n'

// the same hover explainers the overview's StatCard tiles show, keyed by the
// same plain-English labels. "Allocated" only exists on the map scorecards;
// "Works flagged" gets a map-page wording, since these cells aren't links
// (the overview tile's text says "click to open the anomalies queue").
const DESC_KEY = {
  Allocated: 'statDesc.allocated', Recommended: 'statDesc.recommended', Sanctioned: 'statDesc.sanctioned',
  Completed: 'statDesc.completed', Paid: 'statDesc.paid', 'Works flagged': 'statDesc.worksFlaggedMap',
}

// mode: 'amount' (default, unchanged for every existing caller) shows the
// rupee value; 'count' shows the number of projects instead, when the
// caller has one to show (a plain project count, not a currency figure -
// callers with no natural count for a cell, e.g. a lifetime allocation
// ceiling with nothing per-work to count, just omit `count` and this falls
// back to the amount even in count mode). `display` replaces the value
// outright (e.g. "18,924 / 1,07,971"); `description` overrides the shared
// hover text.
export function ScorecardCell({ label, value, count, mode = 'amount', display, description }) {
  const { t } = useLanguage()
  const showCount = mode === 'count' && count != null
  const desc = description ?? (DESC_KEY[label] ? t(DESC_KEY[label]) : undefined)
  const shown = display ?? (showCount ? count.toLocaleString('en-IN') : formatRupees(value))
  return (
    <div className={`scorecard-cell${desc ? ' has-tooltip' : ''}`} tabIndex={desc ? 0 : undefined}>
      <div className="label">{t(label)}</div>
      <div className="value num">{shown}</div>
      {desc && <div className="mospi-stat-tooltip scorecard-tooltip" role="tooltip">{desc}</div>}
    </div>
  )
}
