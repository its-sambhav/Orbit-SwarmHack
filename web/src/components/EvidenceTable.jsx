import { formatRupees } from '../api'
import { useLanguage } from '../i18n'

// Every key a detector in engine/detectors.py puts into evidence.observed/
// threshold/peer_benchmark needs an entry here - a missing label falls back
// to its raw snake_case name, and a rupee amount missing from AMOUNT_KEYS
// prints as a bare number. MP- and district-level findings are labelled as
// such, since their amounts are totals, not this one work's money.
const LABELS = {
  // delay gate (statistical lane) and hard-breach lane
  days: 'Days',
  days_since_last_payment: 'Days since last payment',
  gate_days: 'Flag threshold (days)',
  floor_days: 'Minimum floor (days)',
  guideline_days: 'Guideline (days)',
  limit_days: 'Fixed limit (days)',
  severity_high_ratio: 'Ratio past the limit for "high" severity',
  peer_group: 'Peer group',
  n_peers: 'Comparable works',
  peer_median_days: 'Peer median (days)',
  p90_days: 'Peer 90th percentile (days)',
  p95_days: 'Peer 95th percentile (days)',
  p99_days: 'Peer 99th percentile (days)',

  // dates
  recommendation_date: 'Recommendation date',
  sanction_date: 'Sanction date',
  completion_date: 'Completion date',
  first_payment_date: 'First payment date',
  last_payment_date: 'Last payment date',
  tenure_end: 'Tenure ended',

  // money
  total_paid: 'Total paid',
  sanction_amount: 'Sanctioned amount',
  recommended_amount: 'Recommended amount',
  completed_amount: 'Completed amount (completion record)',
  ratio: 'Ratio',
  max_ratio: 'Maximum ratio allowed',
  relative_gap: 'Gap between paid and completed amount',
  max_relative_gap: 'Maximum gap allowed',
  post_completion_paid: 'Paid after completion',
  post_completion_share: 'Share paid after completion',
  min_lag_days: 'Minimum days after completion',
  min_post_share: 'Minimum share paid after completion',
  robust_z: 'Robust z-score (log amount)',
  ratio_to_peer_median: 'Times the peer median',
  z_low: 'Flag threshold (z)',
  z_medium: 'Medium severity from (z)',
  min_peers: 'Minimum peer group size',
  min_mad_log10: 'Minimum spread used (log10)',
  peer_state: 'Peer group - state',
  peer_activity: 'Peer group - activity',
  peer_median_amount: 'Peer median amount',
  peer_mad_log10: 'Peer spread (log10 MAD)',

  // eligibility - MP-portfolio totals, not this one work's amount
  matched_phrase: 'Matched phrase',
  financial_year: 'Financial year',
  trust_society_recommended: 'Recommended to trusts/societies (MP, this year)',
  cap: 'Ceiling',
  total_recommended: 'MP portfolio recommended (active works, this tenure)',
  allocated: 'MPLADS allocation (this tenure)',
  overage_share: 'Share over allocation',
  min_overage_share: 'Flag above share over',
  works_counted: 'Works counted toward this total',
  sc_share_estimated: 'Estimated share to SC areas',
  st_share_estimated: 'Estimated share to ST areas',
  sc_shortfall: 'SC shortfall (estimated)',
  st_shortfall: 'ST shortfall (estimated)',
  sc_target_share: 'SC target share',
  st_target_share: 'ST target share',
  utilisation: 'Share of allocation spent',
  min_utilisation: 'Minimum expected share',

  // duplication
  matched_works: 'Matching work numbers',
  matched_work_count: 'Matching works found',
  other_mps: 'Recommended also by',
  min_description_length: 'Minimum description length',
  max_group_size: 'Maximum group size considered',
  amount_tolerance: 'Amount tolerance',
  min_jaccard: 'Minimum text similarity',

  // concentration - a district aggregate, not this one work's amount
  district: 'District',
  agency: 'Implementing agency',
  agency_paid: "Agency's payments in this district",
  district_paid: 'Total payments in district',
  district_agencies: 'Agencies paid in district',
  agency_works: "Agency's works in this district",
  share: "Agency's share of district payments",
  hhi: 'District concentration (HHI)',
  p90_share: 'Flag threshold (share, 90th percentile)',
  min_hhi: 'Minimum HHI',
  min_district_agencies: 'Minimum agencies in district',
  min_district_value: 'Minimum district payments',

  // record integrity
  file_attached: 'Supporting file attached',
  calamity: 'Calamity',
  types: 'Recorded as',
  total_consented: 'Total calamity consent',
  max_consent_per_mp: 'Consent ceiling per MP',
}

// rupee amounts
const AMOUNT_KEYS = new Set([
  'total_paid', 'sanction_amount', 'recommended_amount', 'completed_amount', 'post_completion_paid',
  'peer_median_amount', 'trust_society_recommended', 'cap', 'total_recommended', 'allocated',
  'sc_shortfall', 'st_shortfall', 'agency_paid', 'district_paid', 'min_district_value',
  'total_consented', 'max_consent_per_mp',
])
// already on a 0-100 scale - just append '%'
const PERCENT_KEYS = new Set([])
// a 0-1 fraction - multiply by 100 before appending '%'
const FRACTION_PERCENT_KEYS = new Set([
  'relative_gap', 'max_relative_gap', 'post_completion_share', 'min_post_share', 'overage_share',
  'min_overage_share', 'sc_share_estimated', 'st_share_estimated', 'sc_target_share', 'st_target_share',
  'utilisation', 'min_utilisation', 'share', 'p90_share', 'amount_tolerance',
])

// per-detector label/format overrides (none needed at present)
const DETECTOR_OVERRIDES = {}

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
