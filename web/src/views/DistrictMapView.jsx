import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, fetchGeo, formatRupees, queueItemMatches } from '../api'
import { MospiNav } from '../components/MospiNav'
import { IndiaMap, MapLegend } from '../components/IndiaMap'
import { ScorecardCell } from '../components/Scorecard'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'
import { useLanguage } from '../i18n'

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
  const { t, td } = useLanguage()
  const location = useLocation()
  const isRoleView = location.pathname.startsWith('/district-authority/')
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)
  const [severityFilter, setSeverityFilter] = useState('')
  const [queueSearch, setQueueSearch] = useState('')
  const [valueMode, setValueMode] = useState('amount')

  const [pcGeojson, setPcGeojson] = useState(null)
  // state-wide district boundaries + risk, so a State Nodal Authority (or
  // MoSPI) viewing one district can click straight to a sibling district on
  // the map instead of backing out to the state overview first. The District
  // Authority role stays on its own single-district heatmap below - that
  // role has no legitimate access to a neighbouring district's data.
  const [districtsGeojson, setDistrictsGeojson] = useState(null)
  const [stateDistricts, setStateDistricts] = useState(null)

  useEffect(() => { api.meta().then(setMeta).catch(() => {}) }, [])
  useEffect(() => { fetchGeo('india_pc_2019_simplified.geojson').then(setPcGeojson) }, [])
  useEffect(() => {
    if (isRoleView) return
    fetchGeo('india_districts_simplified.geojson').then(setDistrictsGeojson)
  }, [isRoleView])

  useEffect(() => {
    setData(null)
    api.district(stateName, districtName, scope, { dateFrom, dateTo }).then(setData).catch((e) => setError(e.message))
  }, [stateName, districtName, scope, dateFrom, dateTo])

  useEffect(() => {
    if (isRoleView || !data?.state) return
    api.districts(data.state, scope).then(setStateDistricts).catch(() => {})
  }, [isRoleView, data?.state, scope])

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

  const stateDistrictsFilteredGeojson = useMemo(() => {
    if (!districtsGeojson || !data) return null
    const features = districtsGeojson.features.filter((f) => f.properties.state === data.state)
    return features.length ? { type: 'FeatureCollection', features } : null
  }, [districtsGeojson, data])

  const districtDataByKey = useMemo(() => {
    if (!stateDistricts) return {}
    const map = {}
    for (const d of stateDistricts.items) {
      map[d.district] = { works_total: d.works_total, works_flagged: d.works_flagged, breach_rate: d.breach_rate, risk_score: d.risk_score }
    }
    return map
  }, [stateDistricts])

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

  const filteredQueue = data.queue
    .filter((i) => !severityFilter || i.max_severity === severityFilter)
    .filter((i) => queueItemMatches(i, queueSearch))
  const overviewUrl = `${isRoleView ? `/district-authority/${encodeURIComponent(stateName)}/${encodeURIComponent(districtName)}` : `/district/${encodeURIComponent(stateName)}/${encodeURIComponent(districtName)}`}?${params.toString()}`

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={isRoleView
          ? t('District Authority · {district} · Map', { district: td(data.district) })
          : t('MoSPI · {name} · Map', { name: td(data.district) })}
        searchIndex={[]}
        showSearch={!isRoleView}
        profileName={isRoleView ? data.district : undefined}
        profileRole={isRoleView ? 'District Authority' : undefined}
        avatarLetter={isRoleView ? 'D' : undefined}
        drawerLinks={isRoleView ? [
          { label: 'Overview', onClick: () => navigate(overviewUrl) },
        ] : [
          { label: 'Overview', onClick: () => navigate(overviewUrl) },
          { label: 'Anomalies', onClick: () => navigate('/anomalies') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />
      <div className="mospi-map-page-body" id="report-capture">
        <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
          <div className="map-drill-header">
            <Breadcrumb items={isRoleView ? [
              { label: data.district, to: overviewUrl },
              { label: 'drawer.map' },
            ] : [
              { label: data.state, to: `/mospi/map?state=${encodeURIComponent(data.state)}` },
              { label: data.district, to: overviewUrl },
              { label: 'drawer.map' },
            ]} />
            <div className="mospi-header-row">
              <div>
                <h1 style={{ margin: 0 }}>{t(isRoleView ? '{district} — anomaly map' : '{district} — district map', { district: td(data.district) })}</h1>
                <div className="mospi-header-meta">
                  {t(isRoleView ? 'role.district' : 'MoSPI')} · {td(data.state)} · {t(scopeLabel(scope))}
                </div>
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
                <h3 style={{ margin: 0 }}>{t('{name} scorecard', { name: td(data.district) })}</h3>
                <ScopeToggle
                  scopes={[{ value: 'amount', label: 'Amount' }, { value: 'count', label: 'Projects' }]}
                  value={valueMode} onChange={setValueMode} includeAll={false} size="sm"
                />
              </div>
              <div className="scorecard-grid">
                <ScorecardCell label="Allocated" value={data.scorecard.allocated} count={data.scorecard.works_total} mode={valueMode} />
                <ScorecardCell label="Recommended" value={data.scorecard.recommended} count={data.scorecard.recommended_count} mode={valueMode} />
                <ScorecardCell label="Sanctioned" value={data.scorecard.sanctioned} count={data.scorecard.sanctioned_count} mode={valueMode} />
                <ScorecardCell label="Completed" value={data.scorecard.completed} count={data.scorecard.completed_count} mode={valueMode} />
                <ScorecardCell label="Paid" value={data.scorecard.paid} count={data.scorecard.paid_count} mode={valueMode} />
                <div className="scorecard-cell">
                  <div className="label">{t('Works flagged')}</div>
                  <div className="value num">{data.scorecard.works_flagged.toLocaleString('en-IN')} / {data.scorecard.works_total.toLocaleString('en-IN')}</div>
                </div>
              </div>
              <div className="comparison-row">
                <span>{t('Completion rate')}</span>
                <span className="value num">{data.scorecard.completion_rate != null ? `${data.scorecard.completion_rate.toFixed(0)}%` : '—'}</span>
              </div>
              <div className="comparison-row">
                <span>{t('Breach rate')}</span>
                <span className="value num">{(data.breach_rate * 100).toFixed(0)}%</span>
              </div>
              <div className="comparison-row">
                <span>{t('District authority')}</span>
                <span className="value num">{data.district_authority.map(td).join(', ') || '—'}</span>
              </div>
              <div className="comparison-row">
                <span>{t('role.mp')}</span>
                <span className="value num">{data.mps.length ? `${td(data.mps[0].mp_name)} · ${td(data.mps[0].constituency)}` : '—'}</span>
              </div>

              <h3>{t('By tag')}</h3>
              <div className="tag-breakdown">
                {Object.entries(data.tag_breakdown).map(([tag, n]) => (
                  <div key={tag} className="tag-breakdown-row"><TagChip tag={tag} /><span className="num">{n.toLocaleString('en-IN')}</span></div>
                ))}
              </div>
            </div>

            <div className="map-drill-map">
              {!isRoleView && stateDistrictsFilteredGeojson ? (
                <>
                  <IndiaMap
                    geojson={stateDistrictsFilteredGeojson}
                    keyProp="district"
                    nameProp="district"
                    dataByKey={districtDataByKey}
                    focusKey={data.district}
                    onSelect={(risk, key) => navigate(`/district/${encodeURIComponent(data.state)}/${encodeURIComponent(key)}/map?${params.toString()}`)}
                  />
                  <MapLegend />
                </>
              ) : districtFilteredPcGeojson ? (
                <>
                  <IndiaMap
                    geojson={districtFilteredPcGeojson}
                    keyProp="pc_id"
                    nameProp="pc_name"
                    dataByKey={anomalyHeatByKey}
                    backdropGeojson={districtGeojson}
                    overlayGeojson={districtGeojson}
                    tooltipRenderer={(risk, name) => `<strong>${name}</strong><br/>${t(risk.anomaly_count === 1 ? '{n} anomaly' : '{n} anomalies', { n: risk.anomaly_count.toLocaleString('en-IN') })}`}
                  />
                  <div className="map-legend">
                    <div className="map-legend-ramp" />
                    <div className="map-legend-labels"><span>{t('Fewer anomalies')}</span><span>{t('More anomalies')}</span></div>
                    <div className="map-legend-swatch"><span className="map-legend-line" /> {t('District boundary')}</div>
                    <div className="map-legend-swatch"><span className="map-legend-line map-legend-line-dashed" /> {t('Parliamentary constituency')}</div>
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
              <h3>{t('Pending action ({n})', { n: filteredQueue.length })}</h3>
              <div className="filters" style={{ marginBottom: 10 }}>
                <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
                  <option value="">{t('All severities')}</option>
                  <option value="high">{t('High')}</option>
                  <option value="medium">{t('Medium')}</option>
                  <option value="low">{t('Low')}</option>
                </select>
              </div>
              <input
                type="search" className="queue-search-input" placeholder={t('Search works…')} aria-label={t('Search works')}
                value={queueSearch} onChange={(e) => setQueueSearch(e.target.value)}
              />
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
                        <span className="queue-item-title">{td(item.constituency)}</span>
                        <span className="queue-item-amount num">{formatRupees(item.total_exposure)}</span>
                      </div>
                      {item.work_description && <p className="queue-item-desc">{td(item.work_description)}</p>}
                      <div className="queue-item-chips">
                        <SeverityChip severity={item.max_severity} />
                        {item.tags.map((tag) => <TagChip key={tag} tag={tag} />)}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState title="Nothing needs action" subtitle={severityFilter || queueSearch ? 'No flagged works match these filters.' : 'This district has no flagged works for this scope.'} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
