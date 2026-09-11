import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees } from '../api'
import { MospiNav } from '../components/MospiNav'
import { IndiaMap } from '../components/IndiaMap'
import { ScorecardCell } from '../components/Scorecard'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip } from '../components/Chips'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

export function ConstituencyView() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const scope = params.get('scope') || '18th Lok Sabha'
  const navigate = useNavigate()
  const location = useLocation()
  // this view serves two entry points: MoSPI's map drill-down (/constituency/:id,
  // breadcrumb traces India > state > here) and the MP role's own dashboard
  // (/mp/:id, no India/state trail - MospiNav's own "Switch role" link is
  // the way back, so the breadcrumb here is just the current page).
  const isMpRole = location.pathname.startsWith('/mp/')
  const [data, setData] = useState(null)
  const [geojson, setGeojson] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setData(null)
    api.constituency(id, scope).then(setData).catch((e) => setError(e.message))
  }, [id, scope])

  useEffect(() => {
    fetch('/static/geo/india_pc_2019_simplified.geojson').then((r) => r.json()).then(setGeojson)
  }, [])

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading constituency" />

  const { scorecard } = data
  const completionDelta = scorecard.completion_rate != null && scorecard.national_median_completion_rate != null
    ? scorecard.completion_rate - scorecard.national_median_completion_rate
    : null

  const breadcrumbItems = isMpRole
    ? [{ label: data.constituency }]
    : [
        { label: 'India', to: '/mospi/map' },
        { label: data.state, to: `/mospi/map?state=${encodeURIComponent(data.state)}` },
        { label: data.constituency },
      ]

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={`MoSPI · ${data.constituency} · ${scope}`}
        searchIndex={[]}
        drawerLinks={[
          { label: 'Overview', onClick: () => navigate('/mospi') },
          { label: 'Map', onClick: () => navigate('/mospi/map') },
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />
      <div className="mospi-map-page-body">
      <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
      <div className="map-drill-header">
        <Breadcrumb items={breadcrumbItems} />
        <h1 style={{ margin: '4px 0 2px' }}>{data.constituency}</h1>
        <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13 }}>{data.state} · {scope}</div>
      </div>

      <div className="map-drill-row">
        <div className="map-drill-details">
          <h3>MP scorecard</h3>
          <p className="fact-line">{data.mp_name || 'MP not on record for this scope'}</p>
          <div className="scorecard-grid">
            <ScorecardCell label="Allocated" value={scorecard.allocated} />
            <ScorecardCell label="Recommended" value={scorecard.recommended} />
            <ScorecardCell label="Sanctioned" value={scorecard.sanctioned} />
            <ScorecardCell label="Completed" value={scorecard.completed} />
            <ScorecardCell label="Paid" value={scorecard.paid} />
            <div className="scorecard-cell">
              <div className="label">Works flagged</div>
              <div className="value num">{scorecard.works_flagged.toLocaleString('en-IN')} / {scorecard.works_total.toLocaleString('en-IN')}</div>
            </div>
          </div>

          <div className="comparison-row">
            <span>Completion rate here</span>
            <span className="value num">{scorecard.completion_rate != null ? `${scorecard.completion_rate.toFixed(0)}%` : '—'}</span>
          </div>
          <div className="comparison-row">
            <span>National median</span>
            <span className="value num">{scorecard.national_median_completion_rate != null ? `${scorecard.national_median_completion_rate.toFixed(0)}%` : '—'}</span>
          </div>
          <div className="comparison-row">
            <span>State median ({data.state})</span>
            <span className="value num">{scorecard.state_median_completion_rate != null ? `${scorecard.state_median_completion_rate.toFixed(0)}%` : '—'}</span>
          </div>
          {completionDelta != null && (
            <p style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 6 }}>
              {completionDelta >= 0 ? 'Above' : 'Below'} national median by {Math.abs(completionDelta).toFixed(0)} points.
            </p>
          )}

          <h3>By tag</h3>
          <div className="tag-breakdown">
            {Object.entries(data.tag_breakdown).map(([tag, n]) => (
              <div key={tag} className="tag-breakdown-row"><TagChip tag={tag} /><span className="num">{n.toLocaleString('en-IN')}</span></div>
            ))}
          </div>
        </div>

        <div className="map-drill-map">
          {data.pc_id && geojson ? (
            <IndiaMap geojson={geojson} keyProp="pc_id" dataByKey={{}} focusKey={data.pc_id} />
          ) : (
            <EmptyState title="No boundary matched for this constituency" subtitle="Falls in the unmatched tail of the name crosswalk between this dataset and the boundary source." />
          )}
        </div>

        <div className="map-drill-findings">
          <h3>Findings ({data.findings.length})</h3>
          {data.findings.length ? (
            <div className="queue-list">
              {data.findings.map((f) => (
                <button
                  key={`${f.work_number}-${f.scope_house}-${f.scope_tenure}`}
                  className="queue-item"
                  onClick={() => navigate(`/work/${f.work_number}?scope_house=${encodeURIComponent(f.scope_house)}&scope_tenure=${encodeURIComponent(f.scope_tenure)}`)}
                >
                  <div className="queue-item-top">
                    <span className="queue-item-title">Work #{f.work_number}</span>
                    <span className="queue-item-amount num">{formatRupees(f.total_exposure)}</span>
                  </div>
                  <div className="queue-item-chips">
                    <SeverityChip severity={f.max_severity} />
                    {f.tags.map((t) => <TagChip key={t} tag={t} />)}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState title="No findings above the queue threshold here" subtitle="This constituency has no work currently past its review floor for this scope." />
          )}
        </div>
      </div>
      </div>
      </div>
    </div>
  )
}
