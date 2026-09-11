import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees } from '../api'
import { MospiNav } from '../components/MospiNav'
import { IndiaMap } from '../components/IndiaMap'
import { ScorecardCell } from '../components/Scorecard'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)

// the content here is identical either way a district is reached - MoSPI's
// own India > State > District drill-down (/district/...) and the District
// Authority role (/district-authority/..., picked from RoleSelector) show
// the same data. Only the chrome differs: the role has no authorized access
// to MoSPI's search or its Overview/Map/Reports pages, so isRoleView turns
// those off rather than forking an otherwise-identical second file.
export function DistrictView() {
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

  useEffect(() => { api.meta().then(setMeta).catch(() => {}) }, [])

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

  // the district's own dissolved boundary (one honest shape - the union of
  // every constituency its IDA handles, not any single one of them), served
  // directly by /api/district/... - see engine/geo_dissolve.py. Rendered the
  // same way ConstituencyView renders its one focused seat: a static
  // highlighted boundary, no per-feature colouring or click-through, since
  // there's exactly one shape to show.
  const districtGeojson = useMemo(() => {
    if (!data?.boundary) return null
    return { type: 'FeatureCollection', features: [data.boundary] }
  }, [data])

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading district" />

  const filteredQueue = severityFilter ? data.queue.filter((i) => i.max_severity === severityFilter) : data.queue

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={isRoleView ? `District Authority · ${data.district}` : `MoSPI · ${data.district} · ${scopeLabel(scope)}`}
        searchIndex={[]}
        showSearch={!isRoleView}
        profileName={isRoleView ? data.district : undefined}
        profileRole={isRoleView ? 'District Authority' : undefined}
        avatarLetter={isRoleView ? 'D' : undefined}
        drawerLinks={isRoleView ? [
          { label: 'Implementing agencies', onClick: () => document.getElementById('district-agencies')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        ] : [
          { label: 'Overview', onClick: () => navigate('/mospi') },
          { label: 'Map', onClick: () => navigate('/mospi/map') },
          { label: 'Implementing agencies', onClick: () => document.getElementById('district-agencies')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />
      <div className="mospi-map-page-body">
        <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
          <div className="map-drill-header">
            <Breadcrumb items={isRoleView ? [{ label: data.district }] : [
              { label: data.state, to: `/mospi/map?state=${encodeURIComponent(data.state)}` },
              { label: data.district },
            ]} />
            <h1 style={{ margin: '4px 0 2px' }}>{data.district}</h1>
            <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13 }}>District Authority · {data.state} · {scopeLabel(scope)}</div>
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

          <div className="map-drill-row">
            <div className="map-drill-details">
              <h3>District overview</h3>
              <div className="scorecard-grid">
                <ScorecardCell label="Allocated" value={data.scorecard.allocated} />
                <ScorecardCell label="Sanctioned" value={data.scorecard.sanctioned} />
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

              <h3 id="district-agencies">Implementing agency performance</h3>
              {data.agency_performance.length ? (
                <div className="tag-breakdown">
                  {data.agency_performance.map((a) => (
                    <div key={a.agency} className="tag-breakdown-row" style={{ alignItems: 'flex-start' }}>
                      <span style={{ maxWidth: '60%' }}>{a.agency}</span>
                      <span className="num" style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>
                        {a.completed}/{a.works_total} completed · {a.delayed} delayed
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="panel-note">
                  No agency has recorded expenditure here yet - agency identity is only known once a work has a disbursement.
                </p>
              )}

              <h3>District authority</h3>
              {data.district_authority.map((name) => <p key={name} className="fact-line">{name}</p>)}

              <h3>MPs</h3>
              {/* ranked by how many of this district's works that MP actually
                  recommended - DISTRICT is derived from the sanctioning IDA,
                  not the MP's own constituency, so a seat's works can be
                  split across districts near a boundary; the count keeps a
                  1-2-work edge case from reading as an equal co-MP next to a
                  100+-work incumbent. */}
              <div className="tag-breakdown">
                {data.mps.map((m) => (
                  <button
                    key={`${m.constituency_id}-${m.mp_name}`}
                    type="button"
                    className="tag-breakdown-row tag-breakdown-row-btn"
                    onClick={() => navigate(
                      isRoleView
                        ? `/constituency/${m.constituency_id}?scope=${encodeURIComponent(scope)}&role=district&role_name=${encodeURIComponent(data.district)}`
                        : `/constituency/${m.constituency_id}?scope=${encodeURIComponent(scope)}`
                    )}
                  >
                    <span>{m.mp_name}</span>
                    <span className="num" style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>
                      {m.constituency} · {m.works_count.toLocaleString('en-IN')} work{m.works_count === 1 ? '' : 's'}
                    </span>
                  </button>
                ))}
              </div>

              <h3>By tag</h3>
              <div className="tag-breakdown">
                {Object.entries(data.tag_breakdown).map(([tag, n]) => (
                  <div key={tag} className="tag-breakdown-row"><TagChip tag={tag} /><span className="num">{n.toLocaleString('en-IN')}</span></div>
                ))}
              </div>
            </div>

            <div className="map-drill-map">
              {districtGeojson ? (
                <IndiaMap geojson={districtGeojson} keyProp="district" dataByKey={{}} focusKey={data.district} />
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
