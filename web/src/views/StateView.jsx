import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { MospiNav } from '../components/MospiNav'
import { IndiaMap, MapLegend } from '../components/IndiaMap'
import { ScorecardCell } from '../components/Scorecard'
import { Breadcrumb } from '../components/Breadcrumb'
import { Funnel } from '../components/Funnel'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)

const SORTS = {
  risk: { label: 'Risk', fn: (a, b) => b.risk_score - a.risk_score },
  utilization_low: { label: 'Lowest utilization', fn: (a, b) => (a.utilization_rate ?? 1) - (b.utilization_rate ?? 1) },
  utilization_high: { label: 'Highest utilization', fn: (a, b) => (b.utilization_rate ?? -1) - (a.utilization_rate ?? -1) },
  delayed: { label: 'Most delayed', fn: (a, b) => b.delayed - a.delayed },
  completed: { label: 'Most completed', fn: (a, b) => b.works_total - b.works_flagged - (a.works_total - a.works_flagged) },
}

// State Authority's own dashboard - a state-wide view answering "which
// districts need intervention," not a shrunk national command center. No
// national map, no all-India rankings. The central map is the same
// constituency-level choropleth MoSPI's own India > State drill-down shows
// for this state (same geojson, same click-through to a constituency's
// page) - district-level drill-down stays available via the ranked
// list/exceptions panel instead of the map, since districts are a
// derived-from-IDA grouping, not a real boundary MoSPI's own state view
// uses either.
export function StateView() {
  const { stateName } = useParams()
  const [params, setSearchParams] = useSearchParams()
  const scope = params.get('scope') || '18th Lok Sabha'
  const dateFrom = params.get('date_from') || null
  const dateTo = params.get('date_to') || null
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)
  const [sortBy, setSortBy] = useState('risk')
  const [pcGeojson, setPcGeojson] = useState(null)
  const [constituencies, setConstituencies] = useState(null)

  useEffect(() => { api.meta().then(setMeta).catch(() => {}) }, [])
  useEffect(() => { fetch('/static/geo/india_pc_2019_simplified.geojson').then((r) => r.json()).then(setPcGeojson) }, [])
  useEffect(() => { api.constituencies(scope).then(setConstituencies).catch(() => {}) }, [scope])

  useEffect(() => {
    setData(null)
    api.state(stateName, scope, { dateFrom, dateTo }).then(setData).catch((e) => setError(e.message))
  }, [stateName, scope, dateFrom, dateTo])

  function setRange(from, to) {
    const next = new URLSearchParams(params)
    if (from) next.set('date_from', from); else next.delete('date_from')
    if (to) next.set('date_to', to); else next.delete('date_to')
    setSearchParams(next)
  }

  function setScope(next) {
    const p = new URLSearchParams(params)
    p.set('scope', next)
    setSearchParams(p)
  }

  // the same client-side geojson-filter-by-state pattern MospiMapView's own
  // state level uses - same source file, same join key, same click target.
  const stateConstituencies = useMemo(() => {
    if (!constituencies || !data) return []
    return constituencies.items.filter((c) => c.state === data.state && c.pc_id != null)
  }, [constituencies, data])

  const constituencyDataByKey = useMemo(() => {
    const map = {}
    for (const c of stateConstituencies) map[c.pc_id] = c
    return map
  }, [stateConstituencies])

  const stateFilteredPcGeojson = useMemo(() => {
    if (!pcGeojson || !data) return null
    const pcIds = new Set(stateConstituencies.map((c) => c.pc_id))
    return { type: 'FeatureCollection', features: pcGeojson.features.filter((f) => pcIds.has(f.properties.pc_id)) }
  }, [pcGeojson, stateConstituencies, data])

  const sortedDistricts = useMemo(() => {
    if (!data) return []
    return [...data.districts].sort(SORTS[sortBy].fn)
  }, [data, sortBy])

  // exceptions: districts genuinely needing intervention - real signals only
  // (low utilization, a delayed-work backlog, or a pending-approval
  // backlog), not a fabricated "abnormal performance" score.
  const exceptions = useMemo(() => {
    if (!data) return []
    return data.districts
      .filter((d) => d.delayed > 0 || d.pending_approvals > 5 || (d.utilization_rate != null && d.utilization_rate < 0.2))
      .sort((a, b) => b.delayed - a.delayed || b.pending_approvals - a.pending_approvals)
      .slice(0, 8)
  }, [data])

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading state" />

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={`State Nodal Authority · ${data.state}`}
        searchIndex={[]}
        showSearch={false}
        profileName={data.state}
        profileRole="State Nodal Authority"
        avatarLetter="S"
        drawerLinks={[
          { label: 'Needs attention', onClick: () => document.getElementById('state-attention')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
          { label: 'Districts', onClick: () => document.getElementById('state-districts')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        ]}
      />
      <div className="mospi-map-page-body">
        <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
          <div className="map-drill-header">
            <Breadcrumb items={[{ label: data.state }]} />
            <h1 style={{ margin: '4px 0 2px' }}>{data.state}</h1>
            <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
              State Nodal Authority · {data.districts.length} districts · {scopeLabel(scope)}
            </div>
            <div className="report-toolbar">
              <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
              <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
              <GenerateReportButton
                level="state" scope={scope} dateFrom={dateFrom} dateTo={dateTo} state={data.state}
                title={`${data.state} — ${scopeLabel(scope)}`} summary={data.scorecard}
              />
            </div>
          </div>

          <div className="map-drill-row">
            <div className="map-drill-details">
              <h3>State overview</h3>
              <div className="scorecard-grid">
                <ScorecardCell label="Allocated" value={data.scorecard.allocated} />
                <ScorecardCell label="Recommended" value={data.scorecard.recommended} />
                <ScorecardCell label="Sanctioned" value={data.scorecard.sanctioned} />
                <ScorecardCell label="Completed" value={data.scorecard.completed} />
                <ScorecardCell label="Paid" value={data.scorecard.paid} />
                <div className="scorecard-cell">
                  <div className="label">Works flagged</div>
                  <div className="value num">{data.scorecard.works_flagged.toLocaleString('en-IN')} / {data.scorecard.works_total.toLocaleString('en-IN')}</div>
                </div>
                <div className="scorecard-cell">
                  <div className="label">Ongoing</div>
                  <div className="value num">{data.scorecard.ongoing.toLocaleString('en-IN')}</div>
                </div>
                <div className="scorecard-cell">
                  <div className="label">Delayed</div>
                  <div className="value num">{data.scorecard.delayed.toLocaleString('en-IN')}</div>
                </div>
                <div className="scorecard-cell">
                  <div className="label">Pending approvals</div>
                  <div className="value num">{data.scorecard.pending_approvals.toLocaleString('en-IN')}</div>
                </div>
                <div className="scorecard-cell">
                  <div className="label">Pending payments</div>
                  <div className="value num">{data.scorecard.pending_payments.toLocaleString('en-IN')}</div>
                </div>
              </div>
              <div className="comparison-row">
                <span>Completion rate</span>
                <span className="value num">{data.scorecard.completion_rate != null ? `${data.scorecard.completion_rate.toFixed(0)}%` : '—'}</span>
              </div>
              <div className="comparison-row">
                <span>National median</span>
                <span className="value num">{data.scorecard.national_median_completion_rate != null ? `${data.scorecard.national_median_completion_rate.toFixed(0)}%` : '—'}</span>
              </div>

              <h3>Implementation trend</h3>
              <p className="panel-note">
                Recommended/sanctioned/completed for {scopeLabel(scope)} - use the date filter above to compare periods.
              </p>
              <Funnel funnel={{
                ...data.funnel,
                never_sanctioned: data.funnel.recommended - data.funnel.sanctioned,
                sanctioned_never_completed: data.funnel.sanctioned - data.funnel.completed,
              }} />
            </div>

            <div className="map-drill-map">
              {stateFilteredPcGeojson ? (
                <>
                  <IndiaMap
                    geojson={stateFilteredPcGeojson}
                    keyProp="pc_id"
                    nameProp="pc_name"
                    dataByKey={constituencyDataByKey}
                    onSelect={(risk) => navigate(`/constituency/${risk.constituency_id}?scope=${encodeURIComponent(scope)}&role=state&role_name=${encodeURIComponent(data.state)}`)}
                  />
                  <MapLegend />
                </>
              ) : (
                <div className="map-pane-fallback"><Loading label="Loading map" /></div>
              )}
            </div>

            <div className="map-drill-findings">
              <h3 id="state-attention">Needs attention ({exceptions.length})</h3>
              {exceptions.length ? (
                <div className="queue-list" style={{ marginBottom: 16 }}>
                  {exceptions.map((d) => (
                    <button
                      key={d.district}
                      className="queue-item"
                      onClick={() => navigate(`/district-authority/${encodeURIComponent(data.state)}/${encodeURIComponent(d.district)}`)}
                    >
                      <div className="queue-item-top">
                        <span className="queue-item-title">{d.district}</span>
                        <span className="queue-item-amount num">
                          {d.utilization_rate != null ? `${(d.utilization_rate * 100).toFixed(0)}% utilized` : '—'}
                        </span>
                      </div>
                      <div className="queue-item-meta">{d.delayed} delayed · {d.pending_approvals} pending approval</div>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState title="No districts flagged" subtitle="No district is showing low utilization, a delay backlog, or a pending-approval backlog for this scope." />
              )}

              <div className="mospi-page-sub-row" style={{ marginBottom: 8 }}>
                <h3 id="state-districts" style={{ margin: 0 }}>Districts ({sortedDistricts.length})</h3>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="scope-select">
                  {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              <div className="rank-list rank-list-compact">
                {sortedDistricts.map((d) => (
                  <button
                    key={d.district}
                    type="button"
                    className="rank-item"
                    onClick={() => navigate(`/district-authority/${encodeURIComponent(data.state)}/${encodeURIComponent(d.district)}`)}
                  >
                    <span className="rank-item-name">{d.district}</span>
                    <span className="rank-item-meta num">{d.works_flagged.toLocaleString('en-IN')} flagged</span>
                    <span className="rank-item-bar"><span style={{ width: `${Math.max(d.breach_rate * 100, 3)}%` }} /></span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
