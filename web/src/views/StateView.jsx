import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees } from '../api'
import { MospiNav } from '../components/MospiNav'
import { IndiaMap, MapLegend } from '../components/IndiaMap'
import { ScorecardCell } from '../components/Scorecard'
import { StatusBarChart, STATUS_COLORS } from '../components/StatusBarChart'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)

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
  const [pcGeojson, setPcGeojson] = useState(null)
  const [constituencies, setConstituencies] = useState(null)
  const [valueMode, setValueMode] = useState('amount')

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

  // the same constituencies the map itself shows, ranked by risk - the
  // state overview's own list of what it covers, not the derived-from-IDA
  // district grouping.
  const sortedConstituencies = useMemo(
    () => [...stateConstituencies].sort((a, b) => b.risk_score - a.risk_score),
    [stateConstituencies]
  )

  const statusItems = data ? [
    { label: 'Recommended', value: data.scorecard.recommended_count, amount: data.scorecard.recommended, color: STATUS_COLORS.recommended },
    { label: 'Sanctioned', value: data.scorecard.sanctioned_count, amount: data.scorecard.sanctioned, color: STATUS_COLORS.sanctioned },
    { label: 'High risk', value: data.scorecard.high_risk_count, amount: data.scorecard.high_risk_amount, color: STATUS_COLORS.highRisk },
    { label: 'Completed', value: data.scorecard.completed_count, amount: data.scorecard.completed, color: STATUS_COLORS.completed },
  ] : []

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
          { label: 'Constituencies', onClick: () => document.getElementById('state-constituencies')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
          { label: 'Anomalies', onClick: () => document.getElementById('state-anomalies')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        ]}
      />
      <div className="mospi-map-page-body" id="report-capture">
        <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
          <div className="map-drill-header">
            <Breadcrumb items={[{ label: data.state }]} />
            <h1 style={{ margin: '4px 0 2px' }}>{data.state}</h1>
            <div className="mospi-page-sub-row">
              <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13, flex: 1, minWidth: 240 }}>
                State Nodal Authority · {stateConstituencies.length} constituencies · {scopeLabel(scope)}
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
          </div>

          <div className="map-drill-row">
            <div className="map-drill-details">
              <div className="mospi-page-sub-row" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>State overview</h3>
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
                <span>National median</span>
                <span className="value num">{data.scorecard.national_median_completion_rate != null ? `${data.scorecard.national_median_completion_rate.toFixed(0)}%` : '—'}</span>
              </div>

              <StatusBarChart title="Projects by status" items={statusItems} />

              <h3 id="state-constituencies">Constituencies ({sortedConstituencies.length})</h3>
              <div className="rank-list rank-list-compact">
                {sortedConstituencies.map((c) => (
                  <button
                    key={c.constituency_id}
                    type="button"
                    className="rank-item"
                    onClick={() => navigate(`/constituency/${c.constituency_id}?scope=${encodeURIComponent(scope)}&role=state&role_name=${encodeURIComponent(data.state)}`)}
                  >
                    <span className="rank-item-name">{c.constituency}</span>
                    <span className="rank-item-meta num">{c.works_flagged.toLocaleString('en-IN')} flagged</span>
                    <span className="rank-item-bar"><span style={{ width: `${Math.max(c.breach_rate * 100, 3)}%` }} /></span>
                  </button>
                ))}
              </div>
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
              <h3 id="state-anomalies">Anomalies ({data.queue.length})</h3>
              {data.queue.length ? (
                <div className="queue-list">
                  {data.queue.map((item) => (
                    <button
                      key={`${item.work_number}-${item.scope_house}-${item.scope_tenure}`}
                      className="queue-item"
                      onClick={() => navigate(`/work/${item.work_number}?scope_house=${encodeURIComponent(item.scope_house)}&scope_tenure=${encodeURIComponent(item.scope_tenure)}&role=state&role_name=${encodeURIComponent(data.state)}`)}
                    >
                      <div className="queue-item-top">
                        <span className="queue-item-title">{item.constituency}, {item.district}</span>
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
                <EmptyState title="No anomalies" subtitle="No flagged works for this scope." />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
