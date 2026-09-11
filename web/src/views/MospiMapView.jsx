import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, buildSearchIndex, formatRupees } from '../api'
import { MospiNav } from '../components/MospiNav'
import { IndiaMap, MapLegend } from '../components/IndiaMap'
import { ScorecardCell } from '../components/Scorecard'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const DEFAULT_SCOPE = '18th Lok Sabha'
const QUEUE_LIMIT = 60
const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)

function QueueList({ items, navigate }) {
  if (!items.length) {
    return <EmptyState title="No findings above the queue threshold here" subtitle="Try a different scope or wait for the next pipeline run." />
  }
  return (
    <div className="queue-list">
      {items.map((item) => (
        <button
          key={`${item.work_number}-${item.scope_house}-${item.scope_tenure}`}
          className="queue-item"
          onClick={() => navigate(`/work/${item.work_number}?scope_house=${encodeURIComponent(item.scope_house)}&scope_tenure=${encodeURIComponent(item.scope_tenure)}`)}
        >
          <div className="queue-item-top">
            <span className="queue-item-title">{item.constituency ? `${item.constituency}, ${item.state ?? ''}` : `Work #${item.work_number}`}</span>
            <span className="queue-item-amount num">{formatRupees(item.total_exposure)}</span>
          </div>
          {(item.mp_name || item.routed_to) && (
            <div className="queue-item-meta">{[item.mp_name, item.routed_to].filter(Boolean).join(' · ')}</div>
          )}
          <div className="queue-item-chips">
            <SeverityChip severity={item.max_severity} />
            {item.tags.map((t) => <TagChip key={t} tag={t} />)}
          </div>
        </button>
      ))}
    </div>
  )
}

export function MospiMapView() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [stateGeojson, setStateGeojson] = useState(null)
  const [pcGeojson, setPcGeojson] = useState(null)
  const [states, setStates] = useState(null)
  const [constituencies, setConstituencies] = useState(null)
  const [funnel, setFunnel] = useState(null)
  const [nationalQueue, setNationalQueue] = useState(null)
  const [stateDetail, setStateDetail] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)

  // level === 'india': the whole country, one polygon per state, coloured by
  // that state's own aggregate breach rate across all its constituencies.
  // level === 'state': one state's own constituencies, coloured (and ranked)
  // among just that state's seats - clicking one goes to the existing,
  // fully-built constituency page (MP scorecard, findings, etc.), which is
  // the map's third layer. The drill level lives in the URL (?state=X), not
  // local state, so a breadcrumb link from elsewhere (or the browser's own
  // back/forward) lands on the right level instead of always resetting to India.
  const selectedState = searchParams.get('state')
  const level = selectedState ? 'state' : 'india'
  const dateFrom = searchParams.get('date_from') || null
  const dateTo = searchParams.get('date_to') || null
  const scope = searchParams.get('scope') || DEFAULT_SCOPE

  function setRange(from, to) {
    const next = new URLSearchParams(searchParams)
    if (from) next.set('date_from', from); else next.delete('date_from')
    if (to) next.set('date_to', to); else next.delete('date_to')
    setSearchParams(next)
  }

  function setScope(next) {
    const params = new URLSearchParams(searchParams)
    params.set('scope', next)
    setSearchParams(params)
  }

  useEffect(() => {
    fetch('/static/geo/india_states_simplified.geojson').then((r) => r.json()).then(setStateGeojson)
    fetch('/static/geo/india_pc_2019_simplified.geojson').then((r) => r.json()).then(setPcGeojson)
    api.meta().then(setMeta).catch(() => {})
  }, [])

  useEffect(() => {
    api.constituencies(scope).then(setConstituencies).catch((e) => setError(e.message))
  }, [scope])

  useEffect(() => {
    api.states({ scope }, { dateFrom, dateTo }).then(setStates).catch((e) => setError(e.message))
    api.funnel(scope, { dateFrom, dateTo }).then(setFunnel).catch((e) => setError(e.message))
    api.queue({ scope, limit: QUEUE_LIMIT }, { dateFrom, dateTo }).then(setNationalQueue).catch((e) => setError(e.message))
  }, [scope, dateFrom, dateTo])

  useEffect(() => {
    if (level !== 'state' || !selectedState) return
    setStateDetail(null)
    api.state(selectedState, scope, { dateFrom, dateTo }).then(setStateDetail).catch((e) => setError(e.message))
  }, [level, selectedState, scope, dateFrom, dateTo])

  const searchIndex = useMemo(() => buildSearchIndex(constituencies), [constituencies])

  const stateDataByKey = useMemo(() => {
    if (!states) return {}
    const map = {}
    for (const s of states.items) map[s.state] = s
    return map
  }, [states])

  const stateConstituencies = useMemo(() => {
    if (!constituencies || !selectedState) return []
    return constituencies.items.filter((c) => c.state === selectedState && c.pc_id != null)
  }, [constituencies, selectedState])

  const constituencyDataByKey = useMemo(() => {
    const map = {}
    for (const c of stateConstituencies) map[c.pc_id] = c
    return map
  }, [stateConstituencies])

  const stateFilteredPcGeojson = useMemo(() => {
    if (!pcGeojson || !selectedState) return null
    const pcIds = new Set(stateConstituencies.map((c) => c.pc_id))
    return { type: 'FeatureCollection', features: pcGeojson.features.filter((f) => pcIds.has(f.properties.pc_id)) }
  }, [pcGeojson, stateConstituencies, selectedState])

  // preserve the current scope/date filter across a level change - drilling
  // into a state (or back out) shouldn't silently reset either.
  function openState(stateName) {
    const params = new URLSearchParams(searchParams)
    params.set('state', stateName)
    setSearchParams(params)
  }
  function backToIndia() {
    const params = new URLSearchParams(searchParams)
    params.delete('state')
    setSearchParams(params)
  }

  if (error) return <ErrorView message={error} onRetry={() => window.location.reload()} />

  const mapReady = level === 'india' ? (stateGeojson && states) : (stateFilteredPcGeojson && constituencies)

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={`MoSPI · India Risk Map · ${scopeLabel(scope)}`}
        scopeWorksTotal={funnel?.total_works}
        searchIndex={searchIndex}
        drawerLinks={[
          { label: 'Overview', onClick: () => navigate('/mospi') },
          { label: 'Map (all India)', onClick: backToIndia },
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />

      <div className="mospi-map-page-body">
        <div className="mospi-map-page-header">
          {level === 'india' ? (
            <>
              <Breadcrumb items={[{ label: 'India' }]} />
              <h1 className="mospi-page-title">India risk map</h1>
              <div className="mospi-page-sub-row">
                <p className="mospi-page-sub">
                  State-level breach rate, {scopeLabel(scope)}. Click a state to see its constituencies.
                </p>
                <div className="report-toolbar">
                  <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
                  <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
                  <GenerateReportButton
                    level="india" scope={scope} dateFrom={dateFrom} dateTo={dateTo}
                    title={`India — ${scopeLabel(scope)}`} summary={funnel}
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <Breadcrumb items={[{ label: 'India', onClick: backToIndia }, { label: selectedState }]} />
              <h1 className="mospi-page-title">{selectedState}</h1>
              <div className="mospi-page-sub-row">
                <p className="mospi-page-sub">
                  Constituency-level breach rate, ranked within {selectedState}. Click a constituency for its full scorecard.
                </p>
                <div className="report-toolbar">
                  <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
                  <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
                  <GenerateReportButton
                    level="state" scope={scope} dateFrom={dateFrom} dateTo={dateTo} state={selectedState}
                    title={`${selectedState} — ${scopeLabel(scope)}`} summary={stateDetail?.scorecard}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="map-drill-row">
          <div className="map-drill-details">
            {level === 'india' ? (
              funnel ? (
                <>
                  <h3>National scorecard</h3>
                  <div className="scorecard-grid">
                    <ScorecardCell label="Allocated" value={funnel.allocated} />
                    <ScorecardCell label="Recommended" value={funnel.recommended_amount} />
                    <ScorecardCell label="Sanctioned" value={funnel.sanctioned_amount} />
                    <ScorecardCell label="Completed" value={funnel.completed_amount} />
                    <ScorecardCell label="Paid" value={funnel.paid} />
                    <div className="scorecard-cell">
                      <div className="label">Works flagged</div>
                      <div className="value num">{funnel.works_flagged.toLocaleString('en-IN')} / {funnel.total_works.toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                  <div className="comparison-row">
                    <span>Completion rate</span>
                    <span className="value num">{funnel.completion_rate != null ? `${funnel.completion_rate.toFixed(0)}%` : '—'}</span>
                  </div>
                  <div className="comparison-row">
                    <span>Breach rate</span>
                    <span className="value num">{funnel.breach_rate != null ? `${(funnel.breach_rate * 100).toFixed(0)}%` : '—'}</span>
                  </div>
                  <div className="comparison-row">
                    <span>States &amp; UTs covered</span>
                    <span className="value num">{states ? states.items.length : '—'}</span>
                  </div>

                  <h3>States ({states.items.length})</h3>
                  <div className="rank-list rank-list-compact">
                    {[...states.items].sort((a, b) => b.risk_score - a.risk_score).map((s) => (
                      <button
                        key={s.state}
                        type="button"
                        className="rank-item"
                        onClick={() => openState(s.state)}
                      >
                        <span className="rank-item-name">{s.state}</span>
                        <span className="rank-item-meta num">{s.works_flagged.toLocaleString('en-IN')} flagged</span>
                        <span className="rank-item-bar"><span style={{ width: `${Math.max(s.breach_rate * 100, 3)}%` }} /></span>
                      </button>
                    ))}
                  </div>
                </>
              ) : <Loading label="Loading scorecard" />
            ) : (
              stateDetail ? (
                <>
                  <h3>{selectedState} scorecard</h3>
                  <div className="scorecard-grid">
                    <ScorecardCell label="Allocated" value={stateDetail.scorecard.allocated} />
                    <ScorecardCell label="Recommended" value={stateDetail.scorecard.recommended} />
                    <ScorecardCell label="Sanctioned" value={stateDetail.scorecard.sanctioned} />
                    <ScorecardCell label="Completed" value={stateDetail.scorecard.completed} />
                    <ScorecardCell label="Paid" value={stateDetail.scorecard.paid} />
                    <div className="scorecard-cell">
                      <div className="label">Works flagged</div>
                      <div className="value num">{stateDetail.scorecard.works_flagged.toLocaleString('en-IN')} / {stateDetail.scorecard.works_total.toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                  <div className="comparison-row">
                    <span>Completion rate here</span>
                    <span className="value num">{stateDetail.scorecard.completion_rate != null ? `${stateDetail.scorecard.completion_rate.toFixed(0)}%` : '—'}</span>
                  </div>
                  <div className="comparison-row">
                    <span>National median</span>
                    <span className="value num">{stateDetail.scorecard.national_median_completion_rate != null ? `${stateDetail.scorecard.national_median_completion_rate.toFixed(0)}%` : '—'}</span>
                  </div>
                  <div className="comparison-row">
                    <span>Breach rate</span>
                    <span className="value num">{(stateDetail.breach_rate * 100).toFixed(0)}%</span>
                  </div>
                  <h3>Constituencies ({stateConstituencies.length})</h3>
                  <div className="rank-list rank-list-compact">
                    {[...stateConstituencies].sort((a, b) => b.risk_score - a.risk_score).map((c) => (
                      <button
                        key={c.constituency_id}
                        type="button"
                        className="rank-item"
                        onClick={() => navigate(`/constituency/${c.constituency_id}?scope=${encodeURIComponent(scope)}`)}
                      >
                        <span className="rank-item-name">{c.constituency}</span>
                        <span className="rank-item-meta num">{c.works_flagged.toLocaleString('en-IN')} flagged</span>
                        <span className="rank-item-bar"><span style={{ width: `${Math.max(c.breach_rate * 100, 3)}%` }} /></span>
                      </button>
                    ))}
                  </div>
                </>
              ) : <Loading label="Loading scorecard" />
            )}
          </div>

          <div className="map-drill-map">
            {mapReady ? (
              level === 'india' ? (
                <>
                  <IndiaMap
                    geojson={stateGeojson}
                    keyProp="state"
                    nameProp="state"
                    dataByKey={stateDataByKey}
                    onSelect={(risk) => openState(risk.state)}
                  />
                  <MapLegend />
                </>
              ) : (
                <>
                  <IndiaMap
                    geojson={stateFilteredPcGeojson}
                    keyProp="pc_id"
                    nameProp="pc_name"
                    dataByKey={constituencyDataByKey}
                    onSelect={(risk) => navigate(`/constituency/${risk.constituency_id}?scope=${encodeURIComponent(scope)}`)}
                  />
                  <MapLegend />
                </>
              )
            ) : (
              <div className="map-pane-fallback"><Loading label="Loading map" /></div>
            )}
          </div>

          <div className="map-drill-findings">
            {level === 'india' ? (
              <>
                <h3>Review queue{nationalQueue ? ` — ${nationalQueue.total.toLocaleString('en-IN')} works` : ''}</h3>
                {nationalQueue ? <QueueList items={nationalQueue.items} navigate={navigate} /> : <Loading />}
              </>
            ) : (
              <>
                <h3>{selectedState} review queue{stateDetail ? ` — ${stateDetail.works_flagged.toLocaleString('en-IN')} works` : ''}</h3>
                {stateDetail ? <QueueList items={stateDetail.queue} navigate={navigate} /> : <Loading />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
