import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, fetchGeo, formatRupees, queueItemMatches } from '../api'
import { MospiNav } from '../components/MospiNav'
import { IndiaMap, MapLegend } from '../components/IndiaMap'
import { ScorecardCell } from '../components/Scorecard'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const ROLE_LABEL = { state: 'State Nodal Authority', district: 'District Authority' }
const ROLE_AVATAR = { state: 'S', district: 'D' }
const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]

// MoSPI's own constituency drill-down (from the map, or from an MP Audits
// profile page) - India > state > here - and ALSO where a State/District
// Authority lands after drilling into one of their own constituencies
// (StateView's map, DistrictView's MPs list). Those callers add ?role=
// &role_name= so this page can drop MoSPI's identity/search/cross-page
// links for them, the same way DistrictView branches on which path it was
// reached from - without ?role, this is unchanged MoSPI chrome. The MP's
// own dashboard is a separate, purpose-built view (MpDashboardView.jsx, at
// /mp/:id), not this page.
export function ConstituencyView() {
  const { id } = useParams()
  const [params, setSearchParams] = useSearchParams()
  const scope = params.get('scope') || '18th Lok Sabha'
  const dateFrom = params.get('date_from') || null
  const dateTo = params.get('date_to') || null
  const role = params.get('role')
  const roleName = params.get('role_name')
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [geojson, setGeojson] = useState(null)
  const [constituencies, setConstituencies] = useState(null)
  const [error, setError] = useState(null)
  const [valueMode, setValueMode] = useState('amount')
  const [queueSearch, setQueueSearch] = useState('')

  useEffect(() => {
    setData(null)
    api.constituency(id, scope, { dateFrom, dateTo }).then(setData).catch((e) => setError(e.message))
  }, [id, scope, dateFrom, dateTo])

  useEffect(() => {
    fetchGeo('india_pc_2019_simplified.geojson').then(setGeojson)
  }, [])

  useEffect(() => { api.meta().then(setMeta).catch(() => {}) }, [])

  function setScope(next) {
    const p = new URLSearchParams(params)
    p.set('scope', next)
    setSearchParams(p)
  }

  function setRange(from, to) {
    const p = new URLSearchParams(params)
    if (from) p.set('date_from', from); else p.delete('date_from')
    if (to) p.set('date_to', to); else p.delete('date_to')
    setSearchParams(p)
  }

  // the nationwide risk list already has real works_total/works_flagged/
  // breach_rate/risk_score per constituency - the same list the search bar
  // and StatesPanel-style rankings already use - so this constituency's map
  // shows real heatmap colour for its state neighbours too, not just an
  // isolated grey outline of the one seat.
  useEffect(() => {
    api.constituencies(scope).then(setConstituencies).catch(() => {})
  }, [scope])

  // this seat's own real scorecard numbers take precedence (data.pc_id may
  // not even appear in the constituencies list's own join if its crosswalk
  // entry differs slightly) - real either way, never a fabricated fallback.
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

  // this seat plus every other constituency in the same state, so the map
  // reads as "this seat in context" rather than one shape floating alone.
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

  if (error) return <ErrorView message={error} />

  // data loads async after every route change into this page (a fresh
  // constituency id, or the same page reached from a different state/
  // district) - the nav/breadcrumb/header shell renders immediately below
  // regardless, and only the three content panels fall back to an inline
  // Loading each, the same progressive pattern MospiMapView's own state-level
  // drill-in already uses. Blanking the whole page (nav included) behind one
  // centered spinner on every drill-down was the "it just reloads" jank this
  // replaces - the frame around the content should never disappear, only the
  // content within it.
  const scorecard = data?.scorecard ?? null
  const completionDelta = scorecard?.completion_rate != null && scorecard?.national_median_completion_rate != null
    ? scorecard.completion_rate - scorecard.national_median_completion_rate
    : null

  // the drill-down trail continues within the role's own authorized scope -
  // back to the state/district page the role itself owns, never back out to
  // a MoSPI-only page - rather than dead-ending with no way to go "up" a level.
  const roleParentLink = role === 'state'
    ? `/state/${encodeURIComponent(roleName)}`
    : role === 'district' && data
    ? `/district-authority/${encodeURIComponent(data.state)}/${encodeURIComponent(roleName)}`
    : null
  const roleQuery = role ? `&role=${role}&role_name=${encodeURIComponent(roleName)}` : ''

  const breadcrumbItems = role ? [
    { label: roleName, to: roleParentLink },
    { label: data ? data.constituency : '…' },
  ] : [
    { label: 'India', to: '/mospi/map' },
    { label: data ? data.state : '…', to: data ? `/mospi/map?state=${encodeURIComponent(data.state)}` : undefined },
    { label: data ? data.constituency : '…' },
  ]

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={role
          ? `${ROLE_LABEL[role]} · ${data ? data.constituency : 'Loading…'}`
          : `MoSPI · ${data ? data.constituency : 'Loading…'} · ${scope}`}
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
      <div className="mospi-map-page-body" id="report-capture">
      <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
      <div className="map-drill-header">
        <Breadcrumb items={breadcrumbItems} />
        <div className="mospi-header-row">
          <h1 style={{ margin: 0 }}>{data ? data.constituency : 'Loading…'}</h1>
          <div className="report-toolbar">
            <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
            <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
            {data && (
              <GenerateReportButton
                level="constituency" scope={scope} state={data.state}
                title={`${data.constituency} — ${scope}`} summary={scorecard}
              />
            )}
          </div>
        </div>
      </div>

      <div className="map-drill-row">
        <div className="map-drill-details">
          {data ? (
            <>
              <div className="mospi-page-sub-row" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>{data.constituency} scorecard</h3>
                <ScopeToggle
                  scopes={[{ value: 'amount', label: 'Amount' }, { value: 'count', label: 'Projects' }]}
                  value={valueMode} onChange={setValueMode} includeAll={false} size="sm"
                />
              </div>
              <p className="fact-line">{data.mp_name || 'MP not on record for this scope'}</p>
              <div className="scorecard-grid">
                <ScorecardCell label="Allocated" value={scorecard.allocated} count={scorecard.works_total} mode={valueMode} />
                <ScorecardCell label="Recommended" value={scorecard.recommended} count={scorecard.recommended_count} mode={valueMode} />
                <ScorecardCell label="Sanctioned" value={scorecard.sanctioned} count={scorecard.sanctioned_count} mode={valueMode} />
                <ScorecardCell label="Completed" value={scorecard.completed} count={scorecard.completed_count} mode={valueMode} />
                <ScorecardCell label="Paid" value={scorecard.paid} count={scorecard.paid_count} mode={valueMode} />
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
            </>
          ) : <Loading label="Loading constituency" />}
        </div>

        <div className="map-drill-map">
          {data ? (
            data.pc_id && geojson ? (
              <>
                <IndiaMap
                  geojson={stateFilteredPcGeojson || geojson}
                  keyProp="pc_id"
                  nameProp="pc_name"
                  dataByKey={constituencyDataByKey}
                  focusKey={data.pc_id}
                  grayscaleUnfocused
                  onSelect={(risk) => {
                    if (risk.constituency_id == null || String(risk.constituency_id) === String(data.constituency_id)) return
                    navigate(
                      `/constituency/${risk.constituency_id}?scope=${encodeURIComponent(scope)}`
                      + (dateFrom ? `&date_from=${dateFrom}` : '') + (dateTo ? `&date_to=${dateTo}` : '') + roleQuery
                    )
                  }}
                />
                <MapLegend grayscaleUnfocused />
              </>
            ) : (
              <EmptyState title="No boundary matched for this constituency" subtitle="Falls in the unmatched tail of the name crosswalk between this dataset and the boundary source." />
            )
          ) : (
            <div className="map-pane-fallback"><Loading label="Loading map" /></div>
          )}
        </div>

        <div className="map-drill-findings">
          {data ? (
            <>
              <h3>Findings ({data.findings.length})</h3>
              {data.findings.length ? (
                <>
                  <input
                    type="search" className="queue-search-input" placeholder="Search works…" aria-label="Search works"
                    value={queueSearch} onChange={(e) => setQueueSearch(e.target.value)}
                  />
                  {data.findings.filter((f) => queueItemMatches(f, queueSearch)).length ? (
                    <div className="queue-list">
                      {data.findings.filter((f) => queueItemMatches(f, queueSearch)).map((f) => (
                        <button
                          key={`${f.work_number}-${f.scope_house}-${f.scope_tenure}`}
                          className="queue-item"
                          onClick={() => navigate(`/work/${f.work_number}?scope_house=${encodeURIComponent(f.scope_house)}&scope_tenure=${encodeURIComponent(f.scope_tenure)}${roleQuery}`)}
                        >
                          <div className="queue-item-top">
                            <span className="queue-item-title">{f.district ? `${f.district} district` : `Work #${f.work_number}`}</span>
                            <span className="queue-item-amount num">{formatRupees(f.total_exposure)}</span>
                          </div>
                          {f.work_description && <p className="queue-item-desc">{f.work_description}</p>}
                          <div className="queue-item-chips">
                            <SeverityChip severity={f.max_severity} />
                            {f.tags.map((t) => <TagChip key={t} tag={t} />)}
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <EmptyState title="No works match your search" subtitle="Try a different work number or keyword." />
                  )}
                </>
              ) : (
                <EmptyState title="No findings above the queue threshold here" subtitle="This constituency has no work currently past its review floor for this scope." />
              )}
            </>
          ) : <Loading label="Loading findings" />}
        </div>
      </div>
      </div>
      </div>
    </div>
  )
}
