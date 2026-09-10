import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees } from '../api'
import { LifecycleTimeline } from '../components/LifecycleTimeline'
import { EvidenceTable } from '../components/EvidenceTable'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip, SuppressedChip } from '../components/Chips'
import { Loading, ErrorView } from '../components/StateViews'

const ACTION_LABEL = { acknowledge: 'Acknowledged', escalate: 'Escalated', dismiss: 'Dismissed' }

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

// the facts flagging this work as an anomaly: detector, evidence, and the
// plain-language note formatted from that same evidence - nothing here is
// an action taken, only what was observed.
function FindingEvidence({ finding, workNumber, scopeHouse, scopeTenure }) {
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
    </div>
  )
}

// updates taken on this anomaly - which desk it's routed to (real, from the
// engine's routing table) and a reviewer's own recorded status (local to
// this session - there's no persisted multi-user workflow behind it, so this
// states the current status, not a fabricated history of what someone did).
function FindingUpdate({ finding }) {
  const [action, setAction] = useState(null)
  return (
    <div className="finding-card">
      <div className="finding-card-top">
        <span className="finding-card-name">{finding.detector.replaceAll('_', ' ')}</span>
        <SeverityChip severity={finding.severity} />
      </div>
      <div className="finding-card-route">Routed to {finding.routed_to}</div>
      <div className="update-status">{action ? ACTION_LABEL[action] : 'No action recorded yet'}</div>
      <div className="actions-row">
        {['acknowledge', 'escalate', 'dismiss'].map((a) => (
          <button
            key={a}
            className={`action-btn${action === a ? ' acknowledged' : ''}`}
            onClick={() => setAction(action === a ? null : a)}
          >
            {action === a ? ACTION_LABEL[a] : a.charAt(0).toUpperCase() + a.slice(1)}
          </button>
        ))}
      </div>
    </div>
  )
}

export function CaseFileView() {
  const { workNumber } = useParams()
  const [params] = useSearchParams()
  const scopeHouse = params.get('scope_house')
  const scopeTenure = params.get('scope_tenure')
  const [work, setWork] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setWork(null)
    api.work(workNumber, scopeHouse, scopeTenure).then(setWork).catch((e) => setError(e.message))
  }, [workNumber, scopeHouse, scopeTenure])

  if (error) return <ErrorView message={error} />
  if (!work) return <Loading label="Loading case file" />

  // this view is reached from 4 different dashboards (MoSPI/state/district/MP
  // queues, or a map click) - the India > state > constituency > work trail
  // is always correct regardless of which one, since it traces the work's own
  // real position in the hierarchy rather than guessing where the click came from.
  const breadcrumbItems = [
    { label: 'India', to: '/mospi/map' },
    { label: work.state, to: `/mospi/map?state=${encodeURIComponent(work.state)}` },
    { label: work.constituency, to: `/constituency/${work.constituency_id}?scope=${encodeURIComponent(scopeTenure)}` },
    { label: `Work #${work.work_number}` },
  ]

  return (
    <div className="map-drill-view">
      <div className="map-drill-header">
        <Breadcrumb items={breadcrumbItems} />
        <h1 style={{ fontSize: 17, margin: '4px 0 2px' }}>Work #{work.work_number}</h1>
        <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
          {work.constituency}, {work.state} · {work.mp_name} · {scopeHouse} / {scopeTenure}
        </div>
      </div>

      <div className="map-drill-row">
        <div className="map-drill-details">
          <h3>Lifecycle</h3>
          <LifecycleTimeline lifecycle={work.lifecycle} />
        </div>

        <div className="map-drill-center">
          <h3>Findings ({work.findings.length})</h3>
          {work.findings.map((f) => (
            <FindingEvidence key={f.finding_id} finding={f} workNumber={work.work_number} scopeHouse={scopeHouse} scopeTenure={scopeTenure} />
          ))}
        </div>

        <div className="map-drill-findings">
          <h3>Updates</h3>
          {work.findings.map((f) => (
            <FindingUpdate key={f.finding_id} finding={f} />
          ))}
        </div>
      </div>
    </div>
  )
}
