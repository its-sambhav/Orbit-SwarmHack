import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees } from '../api'
import { MospiNav } from '../components/MospiNav'
import { LifecycleTimeline } from '../components/LifecycleTimeline'
import { EvidenceTable } from '../components/EvidenceTable'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip, SuppressedChip } from '../components/Chips'
import { Loading, ErrorView } from '../components/StateViews'
import { CaseDiscussion } from '../components/CaseDiscussion'
import { GenerateReportButton } from '../components/ReportTools'
import { useLanguage } from '../i18n'

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
  const { t, td } = useLanguage()
  const [assessment, setAssessment] = useState(null)

  useEffect(() => {
    setAssessment(null)
    api.aiAssessment(workNumber, scopeHouse, scopeTenure).then(setAssessment).catch(() => {})
  }, [workNumber, scopeHouse, scopeTenure])

  if (!assessment) return <p className="ai-risk-empty">{t('Loading…')}</p>
  const pred = assessment.predicted_delay_risk
  const risk = assessment.risk_assessment

  // one reading order per block, the same one both times: score -> what the
  // score means -> the reasons behind it -> which model produced it. The
  // figure leads at the top left because that is where the eye lands; the
  // sentence that used to carry it inline now sits under it as the caption.
  return (
    <>
      <div className="ai-block">
        <p className="ai-block-title">{t('Pre-sanction delay risk')}</p>
        <div className="ai-figures">
          <div className="ai-figure">
            <div className="ai-figure-top">
              <span className="ai-figure-value num">{Math.round(pred.predicted_delay_probability * 100)}%</span>
              <SeverityChip severity={RISK_TIER_SEVERITY[pred.risk_tier] || 'medium'} />
            </div>
            {/* no label under this one - the block title above it is already
                "Pre-sanction delay risk" */}
          </div>
        </div>
        <p className="ai-lede">
          {t('Predicted probability of severe delay before sanction or completion.')}
        </p>
        {pred.drivers.length > 0 && (
          <div className="ai-why">
            <p className="ai-why-title">{t('Why')}</p>
            {/* driver strings come from the model's own feature importances - data, left as-is */}
            <ul className="ai-why-list">
              {pred.drivers.map((d, i) => <li key={i}>{td(d)}</li>)}
            </ul>
          </div>
        )}
        <p className="ai-footnote">
          {t("Model AUC {auc} on held-out historical works - predicts this work's OWN delay risk before/at recommendation, a separate signal from the {n} rule-based findings in the findings list, not a replacement for them.", {
            auc: pred.model_auc.toFixed(2), n: assessment.rule_based_findings.length,
          })}
        </p>
      </div>

      {risk && risk.risk_score !== null && (
        <div className="ai-block">
          <p className="ai-block-title">{t('Overall risk & anomaly (all detectors)')}</p>
          {/* the two figures side by side, each captioned with what it
              actually measures - they answer different questions and were
              previously separable only by a parenthesis */}
          <div className="ai-figures">
            <div className="ai-figure">
              <div className="ai-figure-top">
                <span className="ai-figure-value num">{Math.round(risk.risk_score * 100)}%</span>
                <SeverityChip severity={RISK_TIER_SEVERITY[risk.risk_tier] || 'medium'} />
              </div>
              <p className="ai-figure-label">{t('Overall risk')}</p>
              <p className="ai-figure-caption">{t('Combined risk across every detector')}</p>
            </div>
            <div className="ai-figure">
              <div className="ai-figure-top">
                <span className="ai-figure-value num">{Math.round(risk.anomaly_score * 100)}%</span>
              </div>
              <p className="ai-figure-label">{t('Anomaly score')}</p>
              <p className="ai-figure-caption">{t('How unusual this work is versus the learned baseline')}</p>
            </div>
          </div>
          <p className="ai-lede">
            {t('Scored against every detector, this work sits in the {tier} band for overall risk, and its shape is {anomaly} for a work of this kind.', {
              tier: t(risk.risk_tier).toLowerCase(),
              anomaly: t(risk.is_anomalous ? 'unusual' : 'typical'),
            })}
          </p>
          {risk.top_drivers.length > 0 && (
            <div className="ai-why">
              <p className="ai-why-title">{t('Why')}</p>
              <ul className="ai-why-list">
                {risk.top_drivers.map((d, i) => <li key={i}>{td(d)}</li>)}
              </ul>
            </div>
          )}
          <p className="ai-footnote">
            {t('Model AUC {auc} - a broader model trained on ~21 features engineered from raw amounts, dates, and disbursement records across every lifecycle stage, against whether the work was ever flagged high-severity by any of the 13 rule-based detectors (not just a delay guideline). The anomaly score alongside it is unsupervised - it never learned what "flagged" means, only what a typical work looks like - and the reasons above come from the model\'s own learned feature importances, not a hand-written explanation.', { auc: risk.model_auc.toFixed(2) })}
          </p>
        </div>
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
  const { t } = useLanguage()
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
    return <button className="narrative-btn" onClick={generate}>{t('Generate case-file note')}</button>
  }
  if (state.status === 'loading') {
    return <div className="narrative-box">{t('Generating…')}</div>
  }
  if (state.status === 'failed') {
    return (
      <div>
        <div className="narrative-box">
          {t("Couldn't generate a note ({reason}). The evidence table above is the full record — nothing here depends on this note.", { reason: state.reason })}
        </div>
        <button className="btn-link" onClick={generate}>{t('Try again')}</button>
      </div>
    )
  }
  return (
    <div className="narrative-box">
      <div className="narrative-label">
        <span className="narrative-badge">{t('AI-generated')}</span>
        {t(state.cached
          ? 'formatted from the evidence above · cached — not additional evidence'
          : 'formatted from the evidence above — not additional evidence')}
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
function FindingCard({ finding, workNumber, scopeHouse, scopeTenure, statusRecord, onSaved, defaultOpen }) {
  const { t, td } = useLanguage()
  const [open, setOpen] = useState(!!defaultOpen)
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
    if (!status) { setError(t('Choose a status.')); return }
    if (!reviewerName.trim()) { setError(t('Reviewer name is required.')); return }
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

  // the header carries everything needed to triage a finding without opening
  // it; the evidence table, the note and the review form sit behind the
  // disclosure. Nothing is dropped - a work with six findings just stops
  // being six stacked evidence tables.
  return (
    <div className={`finding-card${open ? ' finding-card-open' : ''}`}>
      <button
        type="button" className="finding-card-top" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="finding-card-caret" aria-hidden="true">{open ? '\u2212' : '+'}</span>
        <span className="finding-card-name">{t(finding.detector.replaceAll('_', ' '))}</span>
        <SeverityChip severity={finding.severity} />
        <TagChip tag={finding.tag} />
        {finding.suppressed && <SuppressedChip />}
        {statusRecord && <span className="finding-card-verdict">{t(STATUS_LABEL[statusRecord.status])}</span>}
        <span className="finding-card-amount num">{formatRupees(finding.financial_exposure)}</span>
      </button>

      {!open && (
        <p className="finding-card-summary">{td(finding.evidence.deviation)}</p>
      )}

      {open && (
      <div className="finding-card-body">
      <EvidenceTable finding={finding} />
      <div className="finding-card-route">{t('Confidence')}: {td(finding.confidence)}</div>
      <div className="finding-note">
        <p className="finding-card-label">{t('Case-file note')}</p>
        <NarrativeBlock finding={finding} workNumber={workNumber} scopeHouse={scopeHouse} scopeTenure={scopeTenure} />
      </div>

      <hr className="finding-card-divider" />
      <p className="finding-card-label">{t('Review')}</p>
      <div className="finding-card-route" style={{ marginTop: 0 }}>{t('Routed to {desk}', { desk: t(finding.routed_to) })}</div>
      <div className="update-status">
        {statusRecord
          ? `${t(STATUS_LABEL[statusRecord.status])} · ${statusRecord.reviewer_name}`
          : t('No status recorded yet')}
      </div>
      <div className="status-form">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('Set status…')}</option>
          {Object.entries(STATUS_LABEL).map(([k, label]) => <option key={k} value={k}>{t(label)}</option>)}
        </select>
        <input
          type="text" placeholder={t('Reviewer name')} value={reviewerName}
          onChange={(e) => setReviewerName(e.target.value)}
        />
        <textarea
          placeholder={t('Note (optional)')} value={note} rows={2}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && <div className="status-form-error">{error}</div>}
        <button type="button" className="action-btn" disabled={saving} onClick={save}>
          {saving ? t('Saving…') : t('Save status')}
        </button>
      </div>
      </div>
      )}
    </div>
  )
}

export function CaseFileView() {
  const { t, td } = useLanguage()
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

  // the worst severity on the work, shown as the chip beside Generate report -
  // the only colour added to this page, and the severity ramp is reserved for
  // exactly this (see tokens.css)
  const topSeverity = ['high', 'medium', 'low'].find((sev) => work.findings.some((f) => f.severity === sev)) || null

  const breadcrumbItems = fromMp
    ? [
        { label: 'drawer.mpAudits', to: '/mp-audits' },
        { label: fromMp, to: `/mp-audits/${encodeURIComponent(fromMp)}?scope=${encodeURIComponent(scopeTenure)}` },
        { label: t('Work #{n}', { n: work.work_number }) },
      ]
    : role === 'state'
    ? [
        { label: roleName, to: `/state/${encodeURIComponent(roleName)}` },
        { label: work.constituency, to: `/constituency/${work.constituency_id}?scope=${encodeURIComponent(scopeTenure)}&role=state&role_name=${encodeURIComponent(roleName)}` },
        { label: t('Work #{n}', { n: work.work_number }) },
      ]
    : role === 'district'
    ? [
        { label: roleName, to: `/district-authority/${encodeURIComponent(work.state)}/${encodeURIComponent(roleName)}` },
        { label: work.constituency, to: `/constituency/${work.constituency_id}?scope=${encodeURIComponent(scopeTenure)}&role=district&role_name=${encodeURIComponent(roleName)}` },
        { label: t('Work #{n}', { n: work.work_number }) },
      ]
    : role === 'agency'
    ? [
        { label: roleName, to: `/agency/${encodeURIComponent(roleName)}` },
        { label: t('Work #{n}', { n: work.work_number }) },
      ]
    : role === 'mp'
    ? [
        { label: roleName, to: `/mp/${encodeURIComponent(roleName)}?scope=${encodeURIComponent(scopeTenure)}` },
        { label: t('Work #{n}', { n: work.work_number }) },
      ]
    : [
        { label: 'India', to: '/mospi/map' },
        { label: work.state, to: `/mospi/map?state=${encodeURIComponent(work.state)}` },
        { label: work.constituency, to: `/constituency/${work.constituency_id}?scope=${encodeURIComponent(scopeTenure)}` },
        { label: t('Work #{n}', { n: work.work_number }) },
      ]

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scopeTenure}
        subtitle={role
          ? t('{role} · Work #{n}', { role: t(ROLE_LABEL[role]), n: work.work_number })
          : t('MoSPI · Work #{n} · {scope}', { n: work.work_number, scope: t(scopeTenure) })}
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
      <div className="mospi-map-page-body casefile-scroll">
      <div className="casefile">

        {/* ---- header: what this case is, and the one control that acts on
             the whole report ---- */}
        <header className="casefile-header">
          <Breadcrumb items={breadcrumbItems} />
          <div className="casefile-title-row">
            <div className="casefile-identity">
              <h1>{t('Work #{n}', { n: work.work_number })}</h1>
              <p className="casefile-meta">
                {td(work.constituency)}, {td(work.state)} · {td(work.mp_name)} · {t(scopeHouse)} / {t(scopeTenure)}
              </p>
            </div>
            <div className="casefile-header-actions">
              {topSeverity && <SeverityChip severity={topSeverity} />}
              <GenerateReportButton
                level="work" scope={scopeTenure} state={work.state}
                title={`Work #${work.work_number} — ${work.constituency}, ${work.state}`}
                summary={{ works_total: 1, works_flagged: work.findings.length ? 1 : 0 }}
              />
            </div>
          </div>
        </header>

        {/* ---- the report: one sheet, read top to bottom. The lifecycle and
             the description are case metadata - they identify the work, they
             are not an argument about it, so they carry no headings and lead
             straight into the two sections that do: why it was flagged, and
             what was detected. ---- */}
        <article className="casefile-report">
          <div className="casefile-report-label">{t('Report')}</div>

          {/* the four lifecycle stages as a metadata strip: same data, same
              component, typographically demoted so it reads as the header of
              the case rather than the subject of it */}
          <div className="casefile-strip">
            <LifecycleTimeline lifecycle={work.lifecycle} horizontal />
          </div>

          <div className="casefile-desc">
            <p className="casefile-label">{t('Work description')}</p>
            {work.work_description
              ? <p className="casefile-description">{td(work.work_description)}</p>
              : <p className="casefile-description casefile-description-empty">{t('No description on record.')}</p>}
          </div>

          <section className="casefile-section">
            <div className="casefile-section-head">
              <h2>{t('Why this was flagged')}</h2>
              <span className="casefile-section-note">{t('Predictive analysis')}</span>
            </div>
            <AiRiskPanel workNumber={work.work_number} scopeHouse={scopeHouse} scopeTenure={scopeTenure} />
          </section>

          <section className="casefile-section">
            <div className="casefile-section-head">
              <h2>{t('What the rules found')}</h2>
              <span className="casefile-count num">
                {t('{n} findings', { n: work.findings.length })}
              </span>
            </div>
            {work.findings.length ? (
              <div className="finding-list">
                {work.findings.map((f, i) => (
                  <FindingCard
                    key={f.finding_id} finding={f} defaultOpen={i === 0}
                    workNumber={work.work_number} scopeHouse={scopeHouse} scopeTenure={scopeTenure}
                    statusRecord={statuses[f.finding_id]} onSaved={handleStatusSaved}
                  />
                ))}
              </div>
            ) : (
              <p className="casefile-description casefile-description-empty">
                {t('No rule-based findings on this work.')}
              </p>
            )}
          </section>
        </article>

        {/* ---- the discussion: same case, the other half of it. Sits on the
             page background rather than on the report sheet, so the break
             between "what the system found" and "what people are doing about
             it" needs no divider to be read. ---- */}
        <CaseDiscussion
          workNumber={work.work_number} scopeHouse={scopeHouse} scopeTenure={scopeTenure}
        />
      </div>
      </div>
    </div>
  )
}
