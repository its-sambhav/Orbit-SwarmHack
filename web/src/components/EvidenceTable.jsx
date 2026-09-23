import { formatRupees } from '../api'
import { useLanguage } from '../i18n'

// Every key any detector in engine/detectors.py puts into evidence.observed/
// threshold/peer_benchmark needs an entry here - a key missing from LABELS
// silently fell back to its raw snake_case name, and a key missing from
// AMOUNT_KEYS/PERCENT_KEYS showed as a bare unformatted number (e.g. a rupee
// figure printed as "241786200" with no ₹/Cr, indistinguishable from a count
// or a percentage). That's what made MP-portfolio-level findings (
// OVER_ALLOCATION, STATUTORY_SC_ST_DEFICIT, AGENCY_CONCENTRATION - whose
// financial_exposure is a portfolio/district aggregate, not this one work's
// own amount) read as if the numbers didn't add up, when they were just
// unlabeled.
const LABELS = {
  // delay-detector day-counts (STALLED_AT_SANCTION/EXECUTION use
  // age_since_recommendation/age_since_sanction as the literal dict key -
  // these two previously had no matching LABELS entry at all)
  age_since_recommendation: 'Days since recommendation',
  sanction_delay_days: 'Days to sanction (from recommendation)',
  age_since_sanction: 'Days since sanction',
  execution_delay_days: 'Days to completion (from sanction)',
  gate_days_this_run: "This run's flag threshold (days)",
  guideline_days: 'Guideline (days)',

  // dates
  first_expenditure_date: 'First disbursement date',
  sanction_date: 'Sanction date',
  recommendation_date: 'Recommendation date',
  actual_end_date: 'Completion date',

  // ghost asset / payment
  completed: 'Marked complete',
  actual_amount: 'Completed amount',
  total_disbursed: 'Total disbursed',
  disbursement_rows: 'Disbursement count',
  file_attached: 'Supporting file attached',

  // stuck status
  work_stage: 'Work stage',
  early_stages: 'Early-stage vocabulary',

  // over-allocation / statutory SC-ST deficit - both MP-portfolio-level
  // aggregates (every work this MP recommended this tenure), not this one
  // work's own amount, which is why these are labelled explicitly as such.
  total_recommended: 'MP portfolio recommended (all works, this tenure)',
  allocated_amt: 'MPLADS allocation (this tenure)',
  overage: 'Amount over allocation',
  works_counted: 'Works counted toward this total',
  sc_amount: 'Recommended to SC areas (portfolio)',
  sc_percentage: 'Share to SC areas',
  st_amount: 'Recommended to ST areas (portfolio)',
  st_percentage: 'Share to ST areas',
  sc_shortfall: 'SC quota shortfall',
  st_shortfall: 'ST quota shortfall',
  total_shortfall: "Total quota shortfall (this finding's exposure)",
  sc_target_pct: 'SC target share',
  st_target_pct: 'ST target share',

  // cost outlier
  sanction_amount: 'Sanctioned amount',
  modified_z_score: 'Modified z-score',
  modified_z_threshold: 'Flag threshold (modified z-score)',
  min_peers: 'Minimum peer group size',

  // duplicate work
  matched_work_count: 'Matching works found',
  matched_works: 'Matching work numbers',
  recommended_amount: 'Recommended amount',
  min_description_length: 'Minimum description length',
  max_group_size: 'Maximum group size considered',

  // agency concentration - a district/agency aggregate, not this one work's
  // own amount.
  district: 'District',
  agency: 'Implementing agency',
  agency_works: "Agency's works in this district",
  agency_value: "Agency's value in this district",
  district_works: 'Total works in district',
  district_value: 'Total value in district',
  district_agencies: 'Distinct agencies in district',
  share_value: "Agency's share of district value",
  share_works: "Agency's share of district works",
  gate_share_this_run: "This run's flag threshold (share)",
  gate_percentile: 'Flag percentile',
  share_basis: 'Share measured by',

  // peer_benchmark - populated by most statistical detectors but previously
  // never rendered here at all.
  population_median_days: 'Peer median (days)',
  population_p90_days: 'Peer 90th percentile (days)',
  n_peers: 'Comparable works/pairs this run',
  peer_activity: 'Peer group — activity',
  peer_state: 'Peer group — state',
  peer_median_amount: 'Peer median amount',
  peer_mad: 'Peer median absolute deviation',
}

// rupee amounts
const AMOUNT_KEYS = new Set([
  'actual_amount', 'total_disbursed', 'total_recommended', 'allocated_amt', 'overage',
  'sc_amount', 'st_amount', 'sc_shortfall', 'st_shortfall', 'total_shortfall',
  'sanction_amount', 'recommended_amount', 'agency_value', 'district_value',
  'peer_median_amount', 'peer_mad',
])
// already on a 0-100 scale - just append '%'
const PERCENT_KEYS = new Set(['sc_percentage', 'st_percentage', 'sc_target_pct', 'st_target_pct'])
// a 0-1 fraction - multiply by 100 before appending '%'
const FRACTION_PERCENT_KEYS = new Set(['share_value', 'share_works', 'gate_share_this_run'])

// engine/detectors.py's dynamic_gate() is one shared helper reused across
// every percentile-gated detector, keyed generically as if its input were
// always a day-count (population_median_days/population_p90_days) - true for
// the 6 delay detectors and STUCK_STATUS, but AGENCY_CONCENTRATION feeds it a
// 0-1 district-agency SHARE instead. Labelling those two keys "(days)"
// unconditionally would read as a unit that's actively wrong for that one
// detector, so this overrides both the label and the value's formatting per
// detector rather than per key alone.
const DETECTOR_OVERRIDES = {
  AGENCY_CONCENTRATION: {
    population_median_days: { label: 'Peer district-agency share (median, this run)', percent: true },
    population_p90_days: { label: 'Peer district-agency share (90th percentile, this run)', percent: true },
  },
}

// LABELS/DETECTOR_OVERRIDES above stay in English: they are the lookup key
// into the STRINGS table, translated at render time below. Values stay as the
// detector emitted them (numbers, dates, work numbers) except the two
// booleans, which are UI words.
function formatValue(key, value, override, t) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? t('Yes') : t('No')
  if (Array.isArray(value)) return value.length ? value.join(', ') : null
  if (override?.percent) return `${(Number(value) * 100).toFixed(1)}%`
  if (AMOUNT_KEYS.has(key)) return formatRupees(value)
  if (PERCENT_KEYS.has(key)) return `${Number(value).toFixed(1)}%`
  if (FRACTION_PERCENT_KEYS.has(key)) return `${(Number(value) * 100).toFixed(1)}%`
  if (typeof value === 'number') return value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  return String(value)
}

function toRows(section, overrides, t) {
  return Object.entries(section || {})
    .filter(([k]) => k !== 'source')
    .map(([k, v]) => [k, formatValue(k, v, overrides?.[k], t), overrides?.[k]?.label])
    .filter(([, v]) => v !== null)
}

export function EvidenceTable({ finding }) {
  const { t, td } = useLanguage()
  const overrides = DETECTOR_OVERRIDES[finding.detector]
  const observed = toRows(finding.evidence.observed, overrides, t)
  const threshold = toRows(finding.evidence.threshold, overrides, t)
  const peerBenchmark = toRows(finding.evidence.peer_benchmark, overrides, t)

  return (
    <div className="evidence-table">
      <div className="evidence-section">
        <h4>{t('Observed')}</h4>
        <table>
          <tbody>
            {observed.map(([k, v, label]) => (
              <tr key={k}><th>{t(label || LABELS[k] || k)}</th><td className="num">{td(v)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {threshold.length > 0 && (
        <div className="evidence-section">
          <h4>{t('Threshold')}</h4>
          <table>
            <tbody>
              {threshold.map(([k, v, label]) => (
                <tr key={k}><th>{t(label || LABELS[k] || k)}</th><td className="num">{td(v)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {peerBenchmark.length > 0 && (
        <div className="evidence-section">
          <h4>{t('Peer benchmark')}</h4>
          <table>
            <tbody>
              {peerBenchmark.map(([k, v, label]) => (
                <tr key={k}><th>{t(label || LABELS[k] || k)}</th><td className="num">{td(v)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="evidence-section">
        <h4>{t('Deviation')}</h4>
        <p className="evidence-deviation">{td(finding.evidence.deviation)}</p>
      </div>

      {finding.evidence.threshold?.source && (
        <div className="evidence-section">
          <h4>{t('Source')}</h4>
          <p className="evidence-source">{td(finding.evidence.threshold.source)}</p>
        </div>
      )}
    </div>
  )
}
