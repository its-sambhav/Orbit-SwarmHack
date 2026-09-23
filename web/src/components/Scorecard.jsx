import { formatRupees } from '../api'
import { useLanguage } from '../i18n'

// mode: 'amount' (default, unchanged for every existing caller) shows the
// rupee value; 'count' shows the number of projects instead, when the
// caller has one to show (a plain project count, not a currency figure -
// callers with no natural count for a cell, e.g. a lifetime allocation
// ceiling with nothing per-work to count, just omit `count` and this falls
// back to the amount even in count mode).
export function ScorecardCell({ label, value, count, mode = 'amount' }) {
  const { t } = useLanguage()
  const showCount = mode === 'count' && count != null
  return (
    <div className="scorecard-cell">
      <div className="label">{t(label)}</div>
      <div className="value num">{showCount ? count.toLocaleString('en-IN') : formatRupees(value)}</div>
    </div>
  )
}
