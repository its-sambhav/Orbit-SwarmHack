import { formatRupees } from '../api'
import { useLanguage } from '../i18n'

// hover explainers, one text per card per Amount / Projects toggle - the
// sentence always describes the number actually on the card (a rupee total
// or a count of works). "Works flagged" shows the same "x / y" in both modes,
// so it has one text, worded for the map (these cells aren't links).
const DESC_KEY = {
  Allocated: 'mapDesc.allocated', Recommended: 'mapDesc.recommended', Sanctioned: 'mapDesc.sanctioned',
  Completed: 'mapDesc.completed', Paid: 'mapDesc.paid',
}
const FIXED_DESC_KEY = { 'Works flagged': 'statDesc.worksFlaggedMap' }

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
  const descKey = DESC_KEY[label] ? `${DESC_KEY[label]}.${showCount ? 'count' : 'amount'}` : FIXED_DESC_KEY[label]
  const desc = description ?? (descKey ? t(descKey) : undefined)
  const shown = display ?? (showCount ? count.toLocaleString('en-IN') : formatRupees(value))
  return (
    <div className={`scorecard-cell${desc ? ' has-tooltip' : ''}`} tabIndex={desc ? 0 : undefined}>
      <div className="label">{t(label)}</div>
      <div className="value num">{shown}</div>
      {desc && <div className="mospi-stat-tooltip scorecard-tooltip" role="tooltip">{desc}</div>}
    </div>
  )
}
