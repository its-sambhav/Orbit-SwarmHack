import { formatRupees } from '../api'

export function ScorecardCell({ label, value }) {
  return (
    <div className="scorecard-cell">
      <div className="label">{label}</div>
      <div className="value num">{formatRupees(value)}</div>
    </div>
  )
}
