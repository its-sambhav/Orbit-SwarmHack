import { formatRupees } from '../api'

const LABELS = {
  days_since_recommendation: 'Days since recommendation',
  sanction_delay_days: 'Days to sanction (from recommendation)',
  days_since_sanction: 'Days since sanction',
  execution_delay_days: 'Days to completion (from sanction)',
  first_expenditure_date: 'First disbursement date',
  sanction_date: 'Sanction date',
  recommendation_date: 'Recommendation date',
  completed: 'Marked complete',
  actual_end_date: 'Completion date',
  actual_amount: 'Completed amount',
  total_disbursed: 'Total disbursed',
  disbursement_rows: 'Disbursement count',
  file_attached: 'Supporting file attached',
  work_stage: 'Work stage',
  guideline_days: 'Guideline (days)',
  early_stages: 'Early-stage vocabulary',
}

const AMOUNT_KEYS = new Set(['actual_amount', 'total_disbursed'])

function formatValue(key, value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (AMOUNT_KEYS.has(key)) return formatRupees(value)
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

export function EvidenceTable({ finding }) {
  const observed = Object.entries(finding.evidence.observed || {})
    .map(([k, v]) => [k, formatValue(k, v)])
    .filter(([, v]) => v !== null)

  const threshold = Object.entries(finding.evidence.threshold || {})
    .filter(([k]) => k !== 'source')
    .map(([k, v]) => [k, formatValue(k, v)])
    .filter(([, v]) => v !== null)

  return (
    <div className="evidence-table">
      <div className="evidence-section">
        <h4>Observed</h4>
        <table>
          <tbody>
            {observed.map(([k, v]) => (
              <tr key={k}><th>{LABELS[k] || k}</th><td className="num">{v}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {threshold.length > 0 && (
        <div className="evidence-section">
          <h4>Threshold</h4>
          <table>
            <tbody>
              {threshold.map(([k, v]) => (
                <tr key={k}><th>{LABELS[k] || k}</th><td className="num">{v}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="evidence-section">
        <h4>Deviation</h4>
        <p className="evidence-deviation">{finding.evidence.deviation}</p>
      </div>

      {finding.evidence.threshold?.source && (
        <div className="evidence-section">
          <h4>Source</h4>
          <p className="evidence-source">{finding.evidence.threshold.source}</p>
        </div>
      )}
    </div>
  )
}
