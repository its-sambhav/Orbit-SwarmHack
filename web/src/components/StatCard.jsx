import { useLanguage } from '../i18n'

// maps a plain English card label onto its i18n keys, so translation happens
// once, here - of the dashboards' cards only Fund utilisation still arrives
// that way; the KPI cards come from ../kpiCards.js already translated, each
// with its own description.
const LABEL_KEY = {
  Recommended: 'stat.recommended', Sanctioned: 'stat.sanctioned', Completed: 'stat.completed', Paid: 'stat.paid',
  'Works flagged': 'stat.worksFlagged', 'Fund utilisation': 'stat.fundUtilisation', 'Completion rate': 'stat.completionRate',
  'Pending works': 'stat.pendingWorks', 'Avg. cost / completed work': 'stat.avgCost',
}
const DESC_KEY = {
  Recommended: 'statDesc.recommended', Sanctioned: 'statDesc.sanctioned', Completed: 'statDesc.completed', Paid: 'statDesc.paid',
  'Works flagged': 'statDesc.worksFlagged', 'Fund utilisation': 'statDesc.fundUtilisation', 'Completion rate': 'statDesc.completionRate',
  'Pending works': 'statDesc.pendingWorks', 'Avg. cost / completed work': 'statDesc.avgCost',
}

/** One KPI tile in a mospi-stats grid. Hovering (or focusing) reveals a
 * translucent explainer of what the metric means, in whichever language the
 * nav's own language picker is set to - `description` overrides the shared
 * default for a page whose card means something slightly different. Passing
 * `onClick` renders the tile as a real button (Money at risk → anomalies
 * queue) instead of a plain div, everything else stays identical. */
export function StatCard({ label, value, sub, onClick, description }) {
  const { t } = useLanguage()
  const displayLabel = LABEL_KEY[label] ? t(LABEL_KEY[label]) : label
  const desc = description ?? (DESC_KEY[label] ? t(DESC_KEY[label]) : undefined)
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag type={onClick ? 'button' : undefined} className="mospi-stat-card" onClick={onClick}>
      <div className="mospi-stat-label">{displayLabel}</div>
      <div className="mospi-stat-value num">{value}</div>
      <div className="mospi-stat-amount num">{sub}</div>
      {desc && <div className="mospi-stat-tooltip" role="tooltip">{desc}</div>}
    </Tag>
  )
}
