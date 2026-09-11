import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatDate, formatRupees } from '../api'
import { MospiNav } from '../components/MospiNav'
import { IndiaMap } from '../components/IndiaMap'
import { ScorecardCell } from '../components/Scorecard'
import { Breadcrumb } from '../components/Breadcrumb'
import { DonutChart, colorForIndex } from '../components/DonutChart'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)
const STAGE_LABEL = (w) => (w.has_completed ? 'Completed' : w.has_sanctioned ? 'Sanctioned' : 'Recommended')

// The MP's own dashboard - constituency development and recommendations,
// not administrative execution. Shows the FULL recommended-works portfolio
// (api.mp already returns every work, not just flagged ones) with
// "under review" language for flagged items, not MoSPI's audit-toned
// "Findings"/evidence-table framing - that distinction is the whole point
// of this being a separate view from ConstituencyView/MoSPI's own page.
export function MpDashboardView() {
  const { id: mpName } = useParams()
  const [params, setSearchParams] = useSearchParams()
  const scope = params.get('scope') || '18th Lok Sabha'
  const dateFrom = params.get('date_from') || null
  const dateTo = params.get('date_to') || null
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [geojson, setGeojson] = useState(null)
  const [error, setError] = useState(null)
  const [districtFilter, setDistrictFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')

  useEffect(() => { api.meta().then(setMeta).catch(() => {}) }, [])
  useEffect(() => { fetch('/static/geo/india_pc_2019_simplified.geojson').then((r) => r.json()).then(setGeojson) }, [])

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

  const filteredWorks = useMemo(() => {
    if (!data) return []
    return data.recommended_works.filter((w) =>
      (!districtFilter || w.district === districtFilter)
      && (!categoryFilter || w.activity === categoryFilter)
    )
  }, [data, districtFilter, categoryFilter])

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading MP dashboard" />

  const { scorecard } = data
  const donutSegments = data.activity_breakdown.map((a, i) => ({ label: a.label, value: a.value, color: colorForIndex(i) }))

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={`Member of Parliament · ${data.mp_name}`}
        searchIndex={[]}
        showSearch={false}
        profileName={data.mp_name}
        profileRole="Member of Parliament"
        avatarLetter="M"
        drawerLinks={[]}
      />
      <div className="mospi-map-page-body">
        <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
          <div className="map-drill-header">
            <Breadcrumb items={[{ label: data.mp_name }]} />
            <h1 style={{ margin: '4px 0 2px' }}>{data.mp_name}</h1>
            <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
              {data.constituency}, {data.state} · {scopeLabel(scope)} · {data.status}
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

          <div className="map-drill-row">
            <div className="map-drill-details">
              <h3>Constituency overview</h3>
              <div className="scorecard-grid">
                <ScorecardCell label="Recommended" value={scorecard.recommended} />
                <ScorecardCell label="Sanctioned" value={scorecard.sanctioned} />
                <ScorecardCell label="Completed" value={scorecard.completed} />
                <ScorecardCell label="Paid" value={scorecard.paid} />
                <div className="scorecard-cell">
                  <div className="label">Total projects</div>
                  <div className="value num">{scorecard.works_total.toLocaleString('en-IN')}</div>
                </div>
                <div className="scorecard-cell">
                  <div className="label">Pending approval</div>
                  <div className="value num">{scorecard.pending_approvals.toLocaleString('en-IN')}</div>
                </div>
              </div>
              <div className="comparison-row">
                <span>Completion rate</span>
                <span className="value num">{scorecard.completion_rate != null ? `${scorecard.completion_rate.toFixed(0)}%` : '—'}</span>
              </div>

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
                <IndiaMap geojson={geojson} keyProp="pc_id" dataByKey={{}} focusKey={data.pc_id} />
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
