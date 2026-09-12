import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees } from '../api'
import { MospiNav } from '../components/MospiNav'
import { IndiaMap, MapLegend } from '../components/IndiaMap'
import { ScorecardCell } from '../components/Scorecard'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)

// The District's own Map page - same separate-page split as StateMapView.jsx
// (DistrictView.jsx is stats+charts only, its map lives here). Reached from
// either /district/... (MoSPI drill-down) or /district-authority/... (the
// role dashboard) - same isRoleView chrome branch DistrictView itself uses.
export function DistrictMapView() {
  const { stateName, districtName } = useParams()
  const [params, setSearchParams] = useSearchParams()
  const scope = params.get('scope') || '18th Lok Sabha'
  const dateFrom = params.get('date_from') || null
  const dateTo = params.get('date_to') || null
  const navigate = useNavigate()
  const location = useLocation()
  const isRoleView = location.pathname.startsWith('/district-authority/')
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)
  const [severityFilter, setSeverityFilter] = useState('')
  const [valueMode, setValueMode] = useState('amount')

  const [pcGeojson, setPcGeojson] = useState(null)

  useEffect(() => { api.meta().then(setMeta).catch(() => {}) }, [])
  useEffect(() => { fetch('/static/geo/india_pc_2019_simplified.geojson').then((r) => r.json()).then(setPcGeojson) }, [])

  useEffect(() => {
    setData(null)
    api.district(stateName, districtName, scope, { dateFrom, dateTo }).then(setData).catch((e) => setError(e.message))
  }, [stateName, districtName, scope, dateFrom, dateTo])

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

  const districtGeojson = useMemo(() => {
    if (!data?.boundary) return null
    return { type: 'FeatureCollection', features: [data.boundary] }
  }, [data])

  const districtFilteredPcGeojson = useMemo(() => {
    if (!pcGeojson || !data) return null
    const pcIds = new Set(data.constituency_details.map((c) => c.pc_id).filter((id) => id != null))
    const features = pcGeojson.features.filter((f) => pcIds.has(f.properties.pc_id))
    return features.length ? { type: 'FeatureCollection', features } : null
  }, [pcGeojson, data])

  const anomalyHeatByKey = useMemo(() => {
    if (!data) return {}
    const nameToPcId = {}
    for (const c of data.constituency_details) if (c.pc_id != null) nameToPcId[c.constituency] = c.pc_id
    const counts = {}
    for (const item of data.queue) {
      const pcId = nameToPcId[item.constituency]
      if (pcId == null) continue
      counts[pcId] = (counts[pcId] || 0) + 1
    }
    const byKey = {}
    for (const c of data.constituency_details) {
      if (c.pc_id == null) continue
      const n = counts[c.pc_id] || 0
      byKey[c.pc_id] = { risk_score: n, anomaly_count: n, constituency: c.constituency }
    }
    return byKey
  }, [data])

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading map" />

  const filteredQueue = severityFilter ? data.queue.filter((i) => i.max_severity === severityFilter) : data.queue
  const overviewUrl = `${isRoleView ? `/district-authority/${encodeURIComponent(stateName)}/${encodeURIComponent(districtName)}` : `/district/${encodeURIComponent(stateName)}/${encodeURIComponent(districtName)}`}?${params.toString()}`

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={isRoleView ? `District Authority · ${data.district} · Map` : `MoSPI · ${data.district} · Map`}
        searchIndex={[]}
        showSearch={!isRoleView}
        profileName={isRoleView ? data.district : undefined}
        profileRole={isRoleView ? 'District Authority' : undefined}
        avatarLetter={isRoleView ? 'D' : undefined}
        drawerLinks={isRoleView ? [
          { label: 'Overview', onClick: () => navigate(overviewUrl) },
        ] : [
          { label: 'Overview', onClick: () => navigate(overviewUrl) },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />
      <div className="mospi-map-page-body" id="report-capture">
        <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
          <div className="map-drill-header">
            <Breadcrumb items={isRoleView ? [
              { label: data.district, to: overviewUrl },
              { label: 'Map' },
            ] : [
              { label: data.state, to: `/mospi/map?state=${encodeURIComponent(data.state)}` },
              { label: data.district, to: overviewUrl },
              { label: 'Map' },
            ]} />
            <h1 style={{ margin: '4px 0 2px' }}>{data.district} — anomaly map</h1>
            <div className="mospi-page-sub-row">
              <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13, flex: 1, minWidth: 240 }}>
                {isRoleView ? 'District Authority' : 'MoSPI'} · {data.state} · {scopeLabel(scope)}
              </div>
              <div className="report-toolbar">
                <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
                <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
                <GenerateReportButton
                  level="district" scope={scope} dateFrom={dateFrom} dateTo={dateTo}
                  state={data.state} district={data.district}
                  title={`${data.district}, ${data.state} — ${scopeLabel(scope)}`}
                  summary={data.scorecard}
                />
              </div>
            </div>
          </div>

          <div className="map-drill-row">
            <div className="map-drill-details">
              <div className="mospi-page-sub-row" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>{data.district} scorecard</h3>
                <ScopeToggle
                  scopes={[{ value: 'amount', label: 'Amount' }, { value: 'count', label: 'Projects' }]}
                  value={valueMode} onChange={setValueMode} includeAll={false}
                />
              </div>
              <div className="scorecard-grid">
                <ScorecardCell label="Allocated" value={data.scorecard.allocated} count={data.scorecard.works_total} mode={valueMode} />
                <ScorecardCell label="Recommended" value={data.scorecard.recommended} count={data.scorecard.recommended_count} mode={valueMode} />
                <ScorecardCell label="Sanctioned" value={data.scorecard.sanctioned} count={data.scorecard.sanctioned_count} mode={valueMode} />
                <ScorecardCell label="Completed" value={data.scorecard.completed} count={data.scorecard.completed_count} mode={valueMode} />
                <ScorecardCell label="Paid" value={data.scorecard.paid} count={data.scorecard.paid_count} mode={valueMode} />
                <div className="scorecard-cell">
                  <div className="label">Works flagged</div>
                  <div className="value num">{data.scorecard.works_flagged.toLocaleString('en-IN')} / {data.scorecard.works_total.toLocaleString('en-IN')}</div>
                </div>
              </div>
              <div className="comparison-row">
                <span>Completion rate</span>
                <span className="value num">{data.scorecard.completion_rate != null ? `${data.scorecard.completion_rate.toFixed(0)}%` : '—'}</span>
              </div>
              <div className="comparison-row">
                <span>Breach rate</span>
                <span className="value num">{(data.breach_rate * 100).toFixed(0)}%</span>
              </div>
              <div className="comparison-row">
                <span>District authority</span>
                <span className="value num">{data.district_authority.join(', ') || '—'}</span>
              </div>
              <div className="comparison-row">
                <span>Member of Parliament</span>
                <span className="value num">{data.mps.length ? `${data.mps[0].mp_name} · ${data.mps[0].constituency}` : '—'}</span>
              </div>

              <h3>By tag</h3>
              <div className="tag-breakdown">
                {Object.entries(data.tag_breakdown).map(([tag, n]) => (
                  <div key={tag} className="tag-breakdown-row"><TagChip tag={tag} /><span className="num">{n.toLocaleString('en-IN')}</span></div>
                ))}
              </div>
            </div>

            <div className="map-drill-map">
              {districtFilteredPcGeojson ? (
                <>
                  <IndiaMap
                    geojson={districtFilteredPcGeojson}
                    keyProp="pc_id"
                    nameProp="pc_name"
                    dataByKey={anomalyHeatByKey}
                    backdropGeojson={districtGeojson}
                    overlayGeojson={districtGeojson}
                    tooltipRenderer={(risk, name) => `<strong>${name}</strong><br/>${risk.anomaly_count.toLocaleString('en-IN')} anomal${risk.anomaly_count === 1 ? 'y' : 'ies'}`}
                  />
                  <div className="map-legend">
                    <div className="map-legend-ramp" />
                    <div className="map-legend-labels"><span>Fewer anomalies</span><span>More anomalies</span></div>
                    <div className="map-legend-swatch"><span className="map-legend-line" /> District boundary</div>
                    <div className="map-legend-swatch"><span className="map-legend-line map-legend-line-dashed" /> Parliamentary constituency</div>
                  </div>
                </>
              ) : districtGeojson ? (
                <>
                  <IndiaMap
                    geojson={districtGeojson}
                    keyProp="district"
                    dataByKey={{
                      [data.district]: {
                        works_total: data.works_total, works_flagged: data.works_flagged,
                        breach_rate: data.breach_rate, risk_score: data.risk_score,
                      },
                    }}
                    focusKey={data.district}
                  />
                  <MapLegend />
                </>
              ) : (
                <div className="map-pane-fallback">
                  <EmptyState title="No boundary matched for this district" subtitle="Falls in the unmatched tail of the name crosswalk between this dataset and the boundary source." />
                </div>
              )}
            </div>

            <div className="map-drill-findings">
              <h3>Pending action ({filteredQueue.length})</h3>
              <div className="filters" style={{ marginBottom: 10 }}>
                <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
                  <option value="">All severities</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
              {filteredQueue.length ? (
                <div className="queue-list">
                  {filteredQueue.map((item) => (
                    <button
                      key={`${item.work_number}-${item.scope_house}-${item.scope_tenure}`}
                      className="queue-item"
                      onClick={() => navigate(
                        `/work/${item.work_number}?scope_house=${encodeURIComponent(item.scope_house)}&scope_tenure=${encodeURIComponent(item.scope_tenure)}`
                        + (isRoleView ? `&role=district&role_name=${encodeURIComponent(data.district)}` : '')
                      )}
                    >
                      <div className="queue-item-top">
                        <span className="queue-item-title">{item.constituency}</span>
                        <span className="queue-item-amount num">{formatRupees(item.total_exposure)}</span>
                      </div>
                      <div className="queue-item-meta">{item.mp_name} · Work #{item.work_number}</div>
                      <div className="queue-item-chips">
                        <SeverityChip severity={item.max_severity} />
                        {item.tags.map((t) => <TagChip key={t} tag={t} />)}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState title="Nothing needs action" subtitle={severityFilter ? 'No flagged works at this severity for this scope.' : 'This district has no flagged works for this scope.'} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
