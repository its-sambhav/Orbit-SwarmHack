import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, buildSearchIndex, fetchGeo, formatRupees, queueItemMatches } from '../api'
import { MospiNav } from '../components/MospiNav'
import { IndiaMap, MapLegend } from '../components/IndiaMap'
import { ScorecardCell } from '../components/Scorecard'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'
import { useLanguage } from '../i18n'

const DEFAULT_SCOPE = '18th Lok Sabha'
const QUEUE_LIMIT = 60
const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)

// title + search share one row (.queue-panel-header) instead of the search
// sitting on its own row below the heading - both this component's own
// callers (India-level and per-state) pass a plain "Risks (N)" title.
function QueueList({ title, items, navigate }) {
  const { t, td } = useLanguage()
  const [search, setSearch] = useState('')
  const filtered = items.filter((item) => queueItemMatches(item, search))
  return (
    <>
      <div className="queue-panel-header">
        <h3>{title}</h3>
        {items.length > 0 && (
          <input
            type="search" className="queue-search-input" placeholder={t('Search works…')} aria-label={t('Search works')}
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
        )}
      </div>
      {!items.length ? (
        <EmptyState title="No findings above the queue threshold here" subtitle="Try a different scope or wait for the next pipeline run." />
      ) : filtered.length ? (
        <div className="queue-list">
          {filtered.map((item) => (
            <button
              key={`${item.work_number}-${item.scope_house}-${item.scope_tenure}`}
              className="queue-item"
              onClick={() => navigate(`/work/${item.work_number}?scope_house=${encodeURIComponent(item.scope_house)}&scope_tenure=${encodeURIComponent(item.scope_tenure)}`)}
            >
              <div className="queue-item-top">
                <span className="queue-item-title">{item.constituency ? `${td(item.constituency)}, ${td(item.state ?? '')}` : t('Work #{n}', { n: item.work_number })}</span>
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
        <EmptyState title="No works match your search" subtitle="Try a different name, work number, or keyword." />
      )}
    </>
  )
}

export function MospiMapView() {
  const navigate = useNavigate()
  const { t, td } = useLanguage()
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
  const [valueMode, setValueMode] = useState('amount')
  // which ranked list the state drill-in's side panel shows - the map itself
  // stays the constituency choropleth either way (same as MoSPI's own
  // sibling build), this only swaps the list below the scorecard.
  const [stateTab, setStateTab] = useState('constituencies')

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
    fetchGeo('india_states_simplified.geojson').then(setStateGeojson)
    fetchGeo('india_pc_2019_simplified.geojson').then(setPcGeojson)
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
        subtitle={t('MoSPI · India Risk Map · {scope}', { scope: t(scopeLabel(scope)) })}
        scopeWorksTotal={funnel?.total_works}
        searchIndex={searchIndex}
        drawerLinks={[
          { label: 'Overview', onClick: () => navigate('/mospi') },
          { label: 'Map (all India)', onClick: backToIndia },
          { label: 'Anomalies', onClick: () => navigate('/anomalies') },
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />

      <div className="mospi-map-page-body" id="report-capture">
        <div className="mospi-map-page-header">
          {level === 'india' ? (
            <>
              <Breadcrumb items={[{ label: 'India' }]} />
              <div className="mospi-header-row">
                <h1 className="mospi-page-title">{t('India risk map')}</h1>
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
              <div className="mospi-header-row">
                <h1 className="mospi-page-title">{td(selectedState)}</h1>
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
                  <div className="mospi-page-sub-row" style={{ marginBottom: 8 }}>
                    <h3 style={{ margin: 0 }}>{t('National scorecard')}</h3>
                    <ScopeToggle
                      scopes={[{ value: 'amount', label: 'Amount' }, { value: 'count', label: 'Projects' }]}
                      value={valueMode} onChange={setValueMode} includeAll={false} size="sm"
                    />
                  </div>
                  <div className="scorecard-grid">
                    <ScorecardCell label="Allocated" value={funnel.allocated} count={funnel.total_works} mode={valueMode} />
                    <ScorecardCell label="Recommended" value={funnel.recommended_amount} count={funnel.recommended} mode={valueMode} />
                    <ScorecardCell label="Sanctioned" value={funnel.sanctioned_amount} count={funnel.sanctioned} mode={valueMode} />
                    <ScorecardCell label="Completed" value={funnel.completed_amount} count={funnel.completed} mode={valueMode} />
                    <ScorecardCell label="Paid" value={funnel.paid} count={funnel.paid_count} mode={valueMode} />
                    <div className="scorecard-cell">
                      <div className="label">{t('Works flagged')}</div>
                      <div className="value num">{funnel.works_flagged.toLocaleString('en-IN')} / {funnel.total_works.toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                  <div className="comparison-row">
                    <span>{t('Completion rate')}</span>
                    <span className="value num">{funnel.completion_rate != null ? `${funnel.completion_rate.toFixed(0)}%` : '—'}</span>
                  </div>
                  <div className="comparison-row">
                    <span>{t('Breach rate')}</span>
                    <span className="value num">{funnel.breach_rate != null ? `${(funnel.breach_rate * 100).toFixed(0)}%` : '—'}</span>
                  </div>
                  <div className="comparison-row">
                    <span>{t('States & UTs covered')}</span>
                    <span className="value num">{states ? states.items.length : '—'}</span>
                  </div>

                  <h3>{t('States ({n})', { n: states.items.length })}</h3>
                  <div className="rank-list rank-list-compact">
                    {[...states.items].sort((a, b) => b.risk_score - a.risk_score).map((s) => (
                      <button
                        key={s.state}
                        type="button"
                        className="rank-item"
                        onClick={() => openState(s.state)}
                      >
                        <span className="rank-item-name">{td(s.state)}</span>
                        <span className="rank-item-meta num">{t('{n} flagged', { n: s.works_flagged.toLocaleString('en-IN') })}</span>
                        <span className="rank-item-bar"><span style={{ width: `${Math.max(s.breach_rate * 100, 3)}%` }} /></span>
                      </button>
                    ))}
                  </div>
                </>
              ) : <Loading label="Loading scorecard" />
            ) : (
              stateDetail ? (
                <>
                  <div className="mospi-page-sub-row" style={{ marginBottom: 8 }}>
                    <h3 style={{ margin: 0 }}>{t('{name} scorecard', { name: td(selectedState) })}</h3>
                    <ScopeToggle
                      scopes={[{ value: 'amount', label: 'Amount' }, { value: 'count', label: 'Projects' }]}
                      value={valueMode} onChange={setValueMode} includeAll={false} size="sm"
                    />
                  </div>
                  <div className="scorecard-grid">
                    <ScorecardCell label="Allocated" value={stateDetail.scorecard.allocated} count={stateDetail.scorecard.works_total} mode={valueMode} />
                    <ScorecardCell label="Recommended" value={stateDetail.scorecard.recommended} count={stateDetail.scorecard.recommended_count} mode={valueMode} />
                    <ScorecardCell label="Sanctioned" value={stateDetail.scorecard.sanctioned} count={stateDetail.scorecard.sanctioned_count} mode={valueMode} />
                    <ScorecardCell label="Completed" value={stateDetail.scorecard.completed} count={stateDetail.scorecard.completed_count} mode={valueMode} />
                    <ScorecardCell label="Paid" value={stateDetail.scorecard.paid} count={stateDetail.scorecard.paid_count} mode={valueMode} />
                    <div className="scorecard-cell">
                      <div className="label">{t('Works flagged')}</div>
                      <div className="value num">{stateDetail.scorecard.works_flagged.toLocaleString('en-IN')} / {stateDetail.scorecard.works_total.toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                  <div className="comparison-row">
                    <span>{t('Completion rate here')}</span>
                    <span className="value num">{stateDetail.scorecard.completion_rate != null ? `${stateDetail.scorecard.completion_rate.toFixed(0)}%` : '—'}</span>
                  </div>
                  <div className="comparison-row">
                    <span>{t('National median')}</span>
                    <span className="value num">{stateDetail.scorecard.national_median_completion_rate != null ? `${stateDetail.scorecard.national_median_completion_rate.toFixed(0)}%` : '—'}</span>
                  </div>
                  <div className="comparison-row">
                    <span>{t('Breach rate')}</span>
                    <span className="value num">{(stateDetail.breach_rate * 100).toFixed(0)}%</span>
                  </div>
                  <div className="mospi-page-sub-row" style={{ marginBottom: 8 }}>
                    <h3 style={{ margin: 0 }}>
                      {stateTab === 'constituencies'
                        ? t('Constituencies ({n})', { n: stateConstituencies.length })
                        : t('Districts ({n})', { n: stateDetail.districts.length })}
                    </h3>
                    <ScopeToggle
                      scopes={[
                        { value: 'constituencies', label: t('Constituencies ({n})', { n: stateConstituencies.length }) },
                        { value: 'districts', label: t('Districts ({n})', { n: stateDetail.districts.length }) },
                      ]}
                      value={stateTab} onChange={setStateTab} includeAll={false}
                    />
                  </div>
                  {stateTab === 'constituencies' ? (
                    <div className="rank-list rank-list-compact">
                      {[...stateConstituencies].sort((a, b) => b.risk_score - a.risk_score).map((c) => (
                        <button
                          key={c.constituency_id}
                          type="button"
                          className="rank-item"
                          onClick={() => navigate(`/constituency/${c.constituency_id}?scope=${encodeURIComponent(scope)}`)}
                        >
                          <span className="rank-item-name">{td(c.constituency)}</span>
                          <span className="rank-item-meta num">{t('{n} flagged', { n: c.works_flagged.toLocaleString('en-IN') })}</span>
                          <span className="rank-item-bar"><span style={{ width: `${Math.max(c.breach_rate * 100, 3)}%` }} /></span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="rank-list rank-list-compact">
                      {[...stateDetail.districts].sort((a, b) => b.risk_score - a.risk_score).map((d) => (
                        <button
                          key={d.district}
                          type="button"
                          className="rank-item"
                          onClick={() => navigate(`/district/${encodeURIComponent(selectedState)}/${encodeURIComponent(d.district)}?scope=${encodeURIComponent(scope)}`)}
                        >
                          <span className="rank-item-name">{td(d.district)}</span>
                          <span className="rank-item-meta num">{t('{n} flagged', { n: d.works_flagged.toLocaleString('en-IN') })}</span>
                          <span className="rank-item-bar"><span style={{ width: `${Math.max(d.breach_rate * 100, 3)}%` }} /></span>
                        </button>
                      ))}
                    </div>
                  )}
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
              nationalQueue
                ? <QueueList title={t('Risks ({n})', { n: nationalQueue.total.toLocaleString('en-IN') })} items={nationalQueue.items} navigate={navigate} />
                : <Loading />
            ) : (
              stateDetail
                ? <QueueList title={t('Risks ({n})', { n: stateDetail.works_flagged.toLocaleString('en-IN') })} items={stateDetail.queue} navigate={navigate} />
                : <Loading />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
