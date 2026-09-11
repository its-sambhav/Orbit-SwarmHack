import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
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

export function DistrictView() {
  const { stateName, districtName } = useParams()
  const [params, setSearchParams] = useSearchParams()
  const scope = params.get('scope') || '18th Lok Sabha'
  const dateFrom = params.get('date_from') || null
  const dateTo = params.get('date_to') || null
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)

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

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={`MoSPI · ${data.district} · ${scopeLabel(scope)}`}
        searchIndex={[]}
        drawerLinks={[
          { label: 'Overview', onClick: () => navigate('/mospi') },
          { label: 'Map', onClick: () => navigate('/mospi/map') },
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />
      <div className="mospi-map-page-body">
        <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
          <div className="map-drill-header">
            <Breadcrumb items={[
              { label: 'India', to: '/mospi/map' },
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
              <h3>District &amp; MP scorecard</h3>
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
              </div>
              <div className="comparison-row">
                <span>Completion rate</span>
                <span className="value num">{data.scorecard.completion_rate != null ? `${data.scorecard.completion_rate.toFixed(0)}%` : '—'}</span>
              </div>
              <div className="comparison-row">
                <span>States &amp; UTs in India</span>
                <span className="value num">{data.total_states}</span>
              </div>

              <h3>District authority</h3>
              {data.district_authority.map((name) => <p key={name} className="fact-line">{name}</p>)}

              <h3>MPs</h3>
              <div className="tag-breakdown">
                {data.mps.map((m) => (
                  <button
                    key={`${m.constituency_id}-${m.mp_name}`}
                    type="button"
                    className="tag-breakdown-row tag-breakdown-row-btn"
                    onClick={() => navigate(`/constituency/${m.constituency_id}?scope=${encodeURIComponent(scope)}`)}
                  >
                    <span>{m.mp_name}</span>
                    <span className="num" style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>{m.constituency}</span>
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
              <h3>Review queue ({data.queue.length})</h3>
              {data.queue.length ? (
                <div className="queue-list">
                  {data.queue.map((item) => (
                    <button
                      key={`${item.work_number}-${item.scope_house}-${item.scope_tenure}`}
                      className="queue-item"
                      onClick={() => navigate(`/work/${item.work_number}?scope_house=${encodeURIComponent(item.scope_house)}&scope_tenure=${encodeURIComponent(item.scope_tenure)}`)}
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
                <EmptyState title="No findings above medium severity here" subtitle="This district has no flagged works for this scope." />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
