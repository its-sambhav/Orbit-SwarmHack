import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, fetchGeo, formatDate, formatRupees } from '../api'
import { MospiNav } from '../components/MospiNav'
import { IndiaMap, MapLegend } from '../components/IndiaMap'
import { Breadcrumb } from '../components/Breadcrumb'
import { DonutChart, colorForIndex } from '../components/DonutChart'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)
const STAGE_LABEL = (w) => (w.has_completed ? 'Completed' : w.has_sanctioned ? 'Sanctioned' : 'Recommended')

// The MP's own Map page - same separate-page split as StateMapView.jsx
// (MpDashboardView.jsx is stats+charts only, its map + recommended-works
// list live here).
export function MpMapView() {
  const { id: mpName } = useParams()
  const [params, setSearchParams] = useSearchParams()
  const scope = params.get('scope') || '18th Lok Sabha'
  const dateFrom = params.get('date_from') || null
  const dateTo = params.get('date_to') || null
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [geojson, setGeojson] = useState(null)
  const [constituencies, setConstituencies] = useState(null)
  const [error, setError] = useState(null)
  const [districtFilter, setDistrictFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')

  useEffect(() => { api.meta().then(setMeta).catch(() => {}) }, [])
  useEffect(() => { fetchGeo('india_pc_2019_simplified.geojson').then(setGeojson) }, [])
  useEffect(() => { api.constituencies(scope).then(setConstituencies).catch(() => {}) }, [scope])

  useEffect(() => {
    setData(null)
    api.mp(mpName, scope, { dateFrom, dateTo }).then(setData).catch((e) => setError(e.message))
  }, [mpName, scope, dateFrom, dateTo])

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

  const districts = useMemo(() => {
    if (!data) return []
    return [...new Set(data.recommended_works.map((w) => w.district).filter(Boolean))].sort()
  }, [data])

  const constituencyDataByKey = useMemo(() => {
    const map = {}
    if (constituencies?.items) {
      for (const c of constituencies.items) {
        if (c.pc_id != null) map[c.pc_id] = c
      }
    }
    if (data?.pc_id != null) {
      const worksTotal = data.scorecard?.works_total || 1
      const worksFlagged = data.scorecard?.works_flagged || 0
      const breachRate = data.scorecard?.breach_rate ?? (worksTotal ? worksFlagged / worksTotal : 0)
      map[data.pc_id] = {
        constituency: data.constituency, state: data.state,
        works_total: worksTotal, works_flagged: worksFlagged,
        breach_rate: breachRate, risk_score: breachRate * 100,
        ...map[data.pc_id],
      }
    }
    return map
  }, [constituencies, data])

  const stateFilteredPcGeojson = useMemo(() => {
    if (!geojson || !data?.state) return null
    const stateName = data.state.trim().toLowerCase()
    const pcIds = new Set(
      (constituencies?.items || [])
        .filter((c) => c.state && c.state.trim().toLowerCase() === stateName && c.pc_id != null)
        .map((c) => c.pc_id)
    )
    if (data.pc_id != null) pcIds.add(data.pc_id)
    const features = geojson.features.filter((f) => pcIds.has(f.properties.pc_id))
    return features.length ? { type: 'FeatureCollection', features } : geojson
  }, [geojson, data, constituencies])

  const filteredWorks = useMemo(() => {
    if (!data) return []
    return data.recommended_works.filter((w) =>
      (!districtFilter || w.district === districtFilter)
      && (!categoryFilter || w.activity === categoryFilter)
    )
  }, [data, districtFilter, categoryFilter])

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading map" />

  const { scorecard } = data
  const donutSegments = data.activity_breakdown.map((a, i) => ({ label: a.label, value: a.value, color: colorForIndex(i) }))
  const overviewUrl = `/mp/${encodeURIComponent(mpName)}?${params.toString()}`

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={`Member of Parliament · ${data.mp_name} · Map`}
        searchIndex={[]}
        showSearch={false}
        profileName={data.mp_name}
        profileRole="Member of Parliament"
        avatarLetter="M"
        drawerLinks={[
          { label: 'Overview', onClick: () => navigate(overviewUrl) },
        ]}
      />
      <div className="mospi-map-page-body" id="report-capture">
        <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
          <div className="map-drill-header">
            <Breadcrumb items={[
              { label: data.mp_name, to: overviewUrl },
              { label: 'Map' },
            ]} />
            <div className="mospi-header-row">
              <div>
                <h1 style={{ margin: 0 }}>{data.mp_name} — constituency map</h1>
                <div className="mospi-header-meta">
                  {data.constituency}, {data.state} · {scopeLabel(scope)} · {data.status}
                </div>
              </div>
              <div className="report-toolbar">
                <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
                <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
                <GenerateReportButton
                  level="mp" scope={scope} dateFrom={dateFrom} dateTo={dateTo}
                  title={`${data.mp_name} — ${scopeLabel(scope)}`} summary={scorecard}
                />
              </div>
            </div>
          </div>

          <div className="map-drill-row">
            <div className="map-drill-details">
              <h3>Fund utilization</h3>
              <div className="comparison-row">
                <span>Allocated</span>
                <span className="value num">{formatRupees(scorecard.allocated)}</span>
              </div>
              <div className="comparison-row">
                <span>Utilized (paid)</span>
                <span className="value num">{formatRupees(scorecard.paid)}</span>
              </div>
              <div className="comparison-row">
                <span>Utilization %</span>
                <span className="value num">{scorecard.allocated ? `${((scorecard.paid / scorecard.allocated) * 100).toFixed(0)}%` : '—'}</span>
              </div>

              <h3>Where the funds are going</h3>
              {donutSegments.length ? (
                <DonutChart compact segments={donutSegments} onSelect={(seg) => setCategoryFilter(seg.label === categoryFilter ? '' : seg.label)} />
              ) : (
                <p className="panel-note">No categorised activity recorded for this window.</p>
              )}
            </div>

            <div className="map-drill-map">
              {data.pc_id && geojson ? (
                <>
                  <IndiaMap
                    geojson={stateFilteredPcGeojson || geojson}
                    keyProp="pc_id"
                    nameProp="pc_name"
                    dataByKey={constituencyDataByKey}
                    focusKey={data.pc_id}
                  />
                  <MapLegend />
                </>
              ) : (
                <EmptyState title="No boundary matched for this constituency" subtitle="Falls in the unmatched tail of the name crosswalk between this dataset and the boundary source." />
              )}
            </div>

            <div className="map-drill-findings">
              <h3>Projects recommended ({filteredWorks.length})</h3>
              <div className="filters" style={{ marginBottom: 10 }}>
                <select value={districtFilter} onChange={(e) => setDistrictFilter(e.target.value)}>
                  <option value="">All districts</option>
                  {districts.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                {categoryFilter && (
                  <button type="button" className="btn-link" onClick={() => setCategoryFilter('')}>
                    Clear category: {categoryFilter} ×
                  </button>
                )}
              </div>
              {filteredWorks.length ? (
                <div className="queue-list">
                  {filteredWorks.map((w) => (
                    <button
                      key={w.work_number}
                      className="queue-item"
                      onClick={() => navigate(`/work/${w.work_number}?scope_house=Lok%20Sabha&scope_tenure=${encodeURIComponent(scope)}&role=mp&role_name=${encodeURIComponent(data.mp_name)}`)}
                    >
                      <div className="queue-item-top">
                        <span className="queue-item-title">{w.activity || `Work #${w.work_number}`}</span>
                        <span className="queue-item-amount num">{formatRupees(w.recommended_amount)}</span>
                      </div>
                      <div className="queue-item-meta">
                        {w.district ? `${w.district} · ` : ''}{STAGE_LABEL(w)} · Recommended {formatDate(w.recommended_date)}
                      </div>
                      {w.tags.length > 0 && (
                        <div className="queue-item-chips">
                          <span className="chip tag-chip">Under review · {w.tags.join(', ')}</span>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState title="No projects match these filters" subtitle="Try clearing a filter or widening the date range." />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
