import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees } from '../api'
import { MospiNav } from '../components/MospiNav'
import { LifecycleTimeline } from '../components/LifecycleTimeline'
import { EvidenceTable } from '../components/EvidenceTable'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip, SuppressedChip } from '../components/Chips'
import { Loading, ErrorView } from '../components/StateViews'

// Maps the ML model's own risk_tier string ("High"/"Medium"/"Low") onto the
// same severity token every rule-based finding already uses (SeverityChip),
// rather than inventing a second colour scale for what is, visually, the
// same kind of signal.
const RISK_TIER_SEVERITY = { High: 'high', Medium: 'medium', Low: 'low' }

// A separate, independent AI signal from the rule-based findings list -
// predicts this work's OWN chance of severe delay (engine/predictive.py, a
// scikit-learn model trained on historical works), fed from its own real
// recommended amount/state/activity/month, never a hypothetical the viewer
// has to supply. Fails silently (returns null, not an error banner) since
// this is a supplementary read, not required to review the case file.
//
// Two independent models feed this, shown as two clearly separated,
// labelled blocks rather than one run-on paragraph - it should always be
// obvious which model produced which number: a narrow pre-sanction delay
// predictor (fires at recommendation time, before money moves), and a
// broader post-hoc risk+anomaly model (scored against every detector's
// output, once there's a real lifecycle to look at).
function AiRiskPanel({ workNumber, scopeHouse, scopeTenure }) {
  const [assessment, setAssessment] = useState(null)

  useEffect(() => {
    setAssessment(null)
    api.aiAssessment(workNumber, scopeHouse, scopeTenure).then(setAssessment).catch(() => {})
  }, [workNumber, scopeHouse, scopeTenure])

  if (!assessment) return <p className="ai-risk-empty">Loading…</p>
  const pred = assessment.predicted_delay_risk
  const risk = assessment.risk_assessment

  return (
    <>
      <div className="ai-risk-block-title">Pre-sanction delay risk</div>
      <div className="ai-risk-stats">
        <div className="ai-risk-stat">
          <div className="ai-risk-stat-top"><SeverityChip severity={RISK_TIER_SEVERITY[pred.risk_tier] || 'medium'} /></div>
          <div className="ai-risk-stat-value num">{Math.round(pred.predicted_delay_probability * 100)}%</div>
          <div className="ai-risk-stat-label">predicted probability of severe sanction/completion delay</div>
        </div>
      </div>
      {pred.drivers.length > 0 && (
        <>
          <p className="ai-risk-why">Why</p>
          <ul className="ai-risk-drivers">
            {pred.drivers.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </>
      )}
      <p className="panel-note">
        Model AUC {pred.model_auc.toFixed(2)} on held-out historical works - predicts this work's OWN
        delay risk before/at recommendation, a separate signal from the {assessment.rule_based_findings.length} rule-based
        finding{assessment.rule_based_findings.length === 1 ? '' : 's'} in the findings list, not a replacement for them.
      </p>

      {risk && risk.risk_score !== null && (
        <>
          <hr className="ai-risk-divider" />
          <div className="ai-risk-block-title">Overall risk &amp; anomaly (all detectors)</div>
          <div className="ai-risk-stats">
            <div className="ai-risk-stat">
              <div className="ai-risk-stat-top"><SeverityChip severity={RISK_TIER_SEVERITY[risk.risk_tier] || 'medium'} /></div>
              <div className="ai-risk-stat-value num">{Math.round(risk.risk_score * 100)}%</div>
              <div className="ai-risk-stat-label">overall risk score</div>
            </div>
            <div className="ai-risk-stat">
              <div className="ai-risk-stat-top"><SeverityChip severity={risk.is_anomalous ? 'high' : 'low'} /></div>
              <div className="ai-risk-stat-value num">{Math.round(risk.anomaly_score * 100)}%</div>
              <div className="ai-risk-stat-label">anomaly score (unsupervised)</div>
            </div>
          </div>
          {risk.top_drivers.length > 0 && (
            <>
              <p className="ai-risk-why">Why</p>
              <ul className="ai-risk-drivers">
                {risk.top_drivers.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </>
          )}
          <p className="panel-note" style={{ marginBottom: 0 }}>
            Model AUC {risk.model_auc.toFixed(2)} - a broader model trained on ~21 features engineered from
            raw amounts, dates, and disbursement records across every lifecycle stage, against whether the
            work was ever flagged high-severity by any of the 13 rule-based detectors (not just a delay
            guideline). The anomaly score alongside it is unsupervised - it never learned what "flagged"
            means, only what a typical work looks like - and the reasons above come from the model's own
            learned feature importances, not a hand-written explanation.
          </p>
        </>
      )}
    </>
  )
}

const STATUS_LABEL = {
  verified: 'Verified issue',
  dismissed: 'Dismissed – false positive',
  under_investigation: 'Under investigation',
}
const ROLE_LABEL = { state: 'State Nodal Authority', district: 'District Authority', agency: 'Implementing Agency', mp: 'Member of Parliament' }
const ROLE_AVATAR = { state: 'S', district: 'D', agency: 'A', mp: 'M' }

function NarrativeBlock({ finding, workNumber, scopeHouse, scopeTenure }) {
  const [state, setState] = useState({ status: 'idle' }) // idle | loading | done | failed

  const generate = async () => {
    setState({ status: 'loading' })
    try {
      const result = await api.narrative(workNumber, scopeHouse, scopeTenure, finding.finding_id)
      if (result.generated) setState({ status: 'done', narrative: result.narrative, cached: result.cached })
      else setState({ status: 'failed', reason: result.reason })
    } catch (e) {
      setState({ status: 'failed', reason: e.message })
    }
  }

  if (state.status === 'idle') {
    return <button className="narrative-btn" onClick={generate}>Generate case-file note</button>
  }
  if (state.status === 'loading') {
    return <div className="narrative-box">Generating…</div>
  }
  if (state.status === 'failed') {
    return (
      <div>
        <div className="narrative-box">
          Couldn't generate a note ({state.reason}). The evidence table above is the full record —
          nothing here depends on this note.
        </div>
        <button className="btn-link" onClick={generate}>Try again</button>
      </div>
    )
  }
  return (
    <div className="narrative-box">
      <div className="narrative-label">
        <span className="narrative-badge">AI-generated</span>
        formatted from the evidence above{state.cached ? ' · cached' : ''} — not additional evidence
      </div>
      {state.narrative}
    </div>
  )
}

// One card per finding: the evidence (detector, severity, tag, amount,
// evidence table, case-file note - what was observed, no action taken)
// stacked above the "Review" section (which desk it's routed to, and a
// reviewer's own recorded verdict, persisted server-side via
// api/finding_status.py so it survives a reload and is the same for every
// viewer of this case file). These used to be two separate parallel lists
// in different columns, matched up only by list position - one card per
// finding means there's nothing left to cross-reference.
function FindingCard({ finding, workNumber, scopeHouse, scopeTenure, statusRecord, onSaved }) {
  const [status, setStatus] = useState(statusRecord?.status || '')
  const [reviewerName, setReviewerName] = useState(statusRecord?.reviewer_name || '')
  const [note, setNote] = useState(statusRecord?.note || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    setStatus(statusRecord?.status || '')
    setReviewerName(statusRecord?.reviewer_name || '')
    setNote(statusRecord?.note || '')
  }, [statusRecord])

  async function save() {
    setError(null)
    if (!status) { setError('Choose a status.'); return }
    if (!reviewerName.trim()) { setError('Reviewer name is required.'); return }
    setSaving(true)
    try {
      const record = await api.setFindingStatus(finding.finding_id, {
        work_number: workNumber, scope_house: scopeHouse, scope_tenure: scopeTenure,
        status, reviewer_name: reviewerName.trim(), note: note.trim() || null,
      })
      onSaved(record)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="finding-card">
      <div className="finding-card-top">
        <span className="finding-card-name">{finding.detector.replaceAll('_', ' ')}</span>
        <SeverityChip severity={finding.severity} />
        <TagChip tag={finding.tag} />
        {finding.suppressed && <SuppressedChip />}
        <span style={{ marginLeft: 'auto' }} className="num">{formatRupees(finding.financial_exposure)}</span>
      </div>
      <EvidenceTable finding={finding} />
      <div className="finding-card-route">Confidence: {finding.confidence}</div>
      <div className="panel" style={{ marginTop: 12, marginBottom: 0 }}>
        <h2>Case-file note</h2>
        <NarrativeBlock finding={finding} workNumber={workNumber} scopeHouse={scopeHouse} scopeTenure={scopeTenure} />
      </div>

      <hr className="finding-card-divider" />
      <p className="finding-card-section-title">Review</p>
      <div className="finding-card-route" style={{ marginTop: 0 }}>Routed to {finding.routed_to}</div>
      <div className="update-status">
        {statusRecord
          ? `${STATUS_LABEL[statusRecord.status]} · ${statusRecord.reviewer_name}`
          : 'No status recorded yet'}
      </div>
      <div className="status-form">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Set status…</option>
          {Object.entries(STATUS_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <input
          type="text" placeholder="Reviewer name" value={reviewerName}
          onChange={(e) => setReviewerName(e.target.value)}
        />
        <textarea
          placeholder="Note (optional)" value={note} rows={2}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && <div className="status-form-error">{error}</div>}
        <button type="button" className="action-btn" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save status'}
        </button>
      </div>
    </div>
  )
}

export function CaseFileView() {
  const { workNumber } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const scopeHouse = params.get('scope_house')
  const scopeTenure = params.get('scope_tenure')
  // set only when this work was opened from an MP's own "works recommended"
  // list (MpProfileView) - the follow-up trail there is MP Audits > MP name >
  // this work, not the geographic India > state > constituency one, since
  // that's the path the user actually took to get here. Distinct from
  // ?role= below: this is MoSPI staff auditing an MP, still full MoSPI chrome.
  const fromMp = params.get('from_mp')
  // set when this work was opened from within a role dashboard (State/
  // District/Agency/MP) - the drill-down trail must stay inside that role's
  // own authorized pages, never fall back to MoSPI's own nav/breadcrumb.
  const role = params.get('role')
  const roleName = params.get('role_name')
  const [work, setWork] = useState(null)
  const [error, setError] = useState(null)
  // keyed by finding_id - an officer's saved verdict on each finding, if any
  const [statuses, setStatuses] = useState({})

  useEffect(() => {
    setWork(null)
    api.work(workNumber, scopeHouse, scopeTenure).then(setWork).catch((e) => setError(e.message))
    api.findingStatuses().then((res) => {
      const byId = {}
      for (const r of res.items) byId[r.finding_id] = r
      setStatuses(byId)
    }).catch(() => {})
  }, [workNumber, scopeHouse, scopeTenure])

  function handleStatusSaved(record) {
    setStatuses((prev) => ({ ...prev, [record.finding_id]: record }))
  }

  if (error) return <ErrorView message={error} />
  if (!work) return <Loading label="Loading case file" />

  const breadcrumbItems = fromMp
    ? [
        { label: 'MP Audits', to: '/mp-audits' },
        { label: fromMp, to: `/mp-audits/${encodeURIComponent(fromMp)}?scope=${encodeURIComponent(scopeTenure)}` },
        { label: `Work #${work.work_number}` },
      ]
    : role === 'state'
    ? [
        { label: roleName, to: `/state/${encodeURIComponent(roleName)}` },
        { label: work.constituency, to: `/constituency/${work.constituency_id}?scope=${encodeURIComponent(scopeTenure)}&role=state&role_name=${encodeURIComponent(roleName)}` },
        { label: `Work #${work.work_number}` },
      ]
    : role === 'district'
    ? [
        { label: roleName, to: `/district-authority/${encodeURIComponent(work.state)}/${encodeURIComponent(roleName)}` },
        { label: work.constituency, to: `/constituency/${work.constituency_id}?scope=${encodeURIComponent(scopeTenure)}&role=district&role_name=${encodeURIComponent(roleName)}` },
        { label: `Work #${work.work_number}` },
      ]
    : role === 'agency'
    ? [
        { label: roleName, to: `/agency/${encodeURIComponent(roleName)}` },
        { label: `Work #${work.work_number}` },
      ]
    : role === 'mp'
    ? [
        { label: roleName, to: `/mp/${encodeURIComponent(roleName)}?scope=${encodeURIComponent(scopeTenure)}` },
        { label: `Work #${work.work_number}` },
      ]
    : [
        { label: 'India', to: '/mospi/map' },
        { label: work.state, to: `/mospi/map?state=${encodeURIComponent(work.state)}` },
        { label: work.constituency, to: `/constituency/${work.constituency_id}?scope=${encodeURIComponent(scopeTenure)}` },
        { label: `Work #${work.work_number}` },
      ]

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scopeTenure}
        subtitle={role ? `${ROLE_LABEL[role]} · Work #${work.work_number}` : `MoSPI · Work #${work.work_number} · ${scopeTenure}`}
        searchIndex={[]}
        showSearch={!role}
        profileName={role ? roleName : undefined}
        profileRole={role ? ROLE_LABEL[role] : undefined}
        avatarLetter={role ? ROLE_AVATAR[role] : undefined}
        drawerLinks={role ? [] : [
          { label: 'Overview', onClick: () => navigate('/mospi') },
          { label: 'Map', onClick: () => navigate('/mospi/map') },
          { label: 'Anomalies', onClick: () => navigate('/anomalies') },
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />
      <div className="mospi-map-page-body">
      <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
      <div className="map-drill-header">
        <Breadcrumb items={breadcrumbItems} />
        <h1 style={{ margin: '4px 0 2px' }}>Work #{work.work_number}</h1>
        <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
          {work.constituency}, {work.state} · {work.mp_name} · {scopeHouse} / {scopeTenure}
        </div>
      </div>

      <div className="case-file-layout">
        <div className="map-drill-details case-file-timeline-panel">
          <h3>Work description</h3>
          {work.work_description
            ? <p className="fact-line">{work.work_description}</p>
            : <p className="fact-line" style={{ color: 'var(--ink-faint)' }}>No description on record.</p>}

          <h3>Timeline</h3>
          <LifecycleTimeline lifecycle={work.lifecycle} horizontal />
        </div>

        <div className="case-file-split">
          <div className="map-drill-center">
            <h3>AI predictive risk</h3>
            <AiRiskPanel workNumber={work.work_number} scopeHouse={scopeHouse} scopeTenure={scopeTenure} />
          </div>

          <div className="map-drill-findings">
            <h3>Findings ({work.findings.length})</h3>
            {work.findings.map((f) => (
              <FindingCard
                key={f.finding_id} finding={f}
                workNumber={work.work_number} scopeHouse={scopeHouse} scopeTenure={scopeTenure}
                statusRecord={statuses[f.finding_id]} onSaved={handleStatusSaved}
              />
            ))}
          </div>
        </div>
      </div>
      </div>
      </div>
    </div>
  )
}
