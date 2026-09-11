import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees } from '../api'
import { MospiNav } from '../components/MospiNav'
import { ScorecardCell } from '../components/Scorecard'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)

// A work-management console, not another geographic government dashboard -
// the work table is the hero, the map is skipped entirely (spec: "optional,
// should NOT dominate" - with no map data pulling its weight here, the
// table earns the space instead). Only works this agency was the single
// largest disburser on - see the caveat banner for what that does and
// doesn't mean.
export function AgencyView() {
  const { agencyName } = useParams()
  const [params, setSearchParams] = useSearchParams()
  const scope = params.get('scope') || '18th Lok Sabha'
  const dateFrom = params.get('date_from') || null
  const dateTo = params.get('date_to') || null
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)
  const [severityFilter, setSeverityFilter] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [valueMode, setValueMode] = useState('amount')

  useEffect(() => { api.meta().then(setMeta).catch(() => {}) }, [])

  useEffect(() => {
    setData(null)
    api.agency(agencyName, scope, { dateFrom, dateTo }).then(setData).catch((e) => setError(e.message))
  }, [agencyName, scope, dateFrom, dateTo])

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

  const filteredQueue = useMemo(() => {
    if (!data) return []
    return data.queue.filter((i) =>
      (!severityFilter || i.max_severity === severityFilter) && (!stateFilter || i.state === stateFilter)
    )
  }, [data, severityFilter, stateFilter])

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading agency" />

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={`Implementing Agency · ${data.agency}`}
        searchIndex={[]}
        showSearch={false}
        profileName={data.agency}
        profileRole="Implementing Agency"
        avatarLetter="A"
        drawerLinks={[]}
      />
      <div className="mospi-map-page-body">
        <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
          <div className="map-drill-header">
            <Breadcrumb items={[{ label: data.agency }]} />
            <h1 style={{ margin: '4px 0 2px' }}>{data.agency}</h1>
            <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
              Implementing Agency · {scopeLabel(scope)}
            </div>
            <div className="report-toolbar">
              <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
              <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
              <GenerateReportButton
                level="agency" scope={scope} dateFrom={dateFrom} dateTo={dateTo} agency={data.agency}
                title={`${data.agency} — ${scopeLabel(scope)}`} summary={data.scorecard}
              />
            </div>
          </div>

          <p className="panel-note" style={{ margin: '0 24px 16px', padding: '10px 14px', background: 'var(--sev-low-bg)', color: 'var(--ink)', borderRadius: 'var(--radius-md)' }}>
            {data.data_caveat}
          </p>

          <div className="map-drill-row map-drill-row-2col">
            <div className="map-drill-details">
              <div className="mospi-page-sub-row" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>My work overview</h3>
                <ScopeToggle
                  scopes={[{ value: 'amount', label: 'Amount' }, { value: 'count', label: 'Projects' }]}
                  value={valueMode} onChange={setValueMode} includeAll={false}
                />
              </div>
              <div className="scorecard-grid">
                <ScorecardCell label="Sanctioned" value={data.scorecard.sanctioned} count={data.scorecard.sanctioned_count} mode={valueMode} />
                <ScorecardCell label="Completed" value={data.scorecard.completed} count={data.scorecard.completed_count} mode={valueMode} />
                <ScorecardCell label="Paid" value={data.scorecard.paid} count={data.scorecard.paid_count} mode={valueMode} />
                <div className="scorecard-cell">
                  <div className="label">Flagged</div>
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
                  <div className="label">Pending payments</div>
                  <div className="value num">{data.scorecard.pending_payments.toLocaleString('en-IN')}</div>
                </div>
              </div>

              <h3>States touched</h3>
              {data.states_touched.map((s) => <p key={s} className="fact-line">{s}</p>)}

              <h3>By tag</h3>
              <div className="tag-breakdown">
                {Object.entries(data.tag_breakdown).map(([tag, n]) => (
                  <div key={tag} className="tag-breakdown-row"><TagChip tag={tag} /><span className="num">{n.toLocaleString('en-IN')}</span></div>
                ))}
              </div>
            </div>

            <div className="map-drill-findings">
              <h3>Assigned works ({filteredQueue.length})</h3>
              <div className="filters" style={{ marginBottom: 10 }}>
                <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
                  <option value="">All severities</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
                <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                  <option value="">All states</option>
                  {data.states_touched.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              {filteredQueue.length ? (
                <div className="queue-list">
                  {filteredQueue.map((item) => (
                    <button
                      key={`${item.work_number}-${item.scope_house}-${item.scope_tenure}`}
                      className="queue-item"
                      onClick={() => navigate(`/work/${item.work_number}?scope_house=${encodeURIComponent(item.scope_house)}&scope_tenure=${encodeURIComponent(item.scope_tenure)}&role=agency&role_name=${encodeURIComponent(data.agency)}`)}
                    >
                      <div className="queue-item-top">
                        <span className="queue-item-title">{item.constituency}, {item.state}</span>
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
                <EmptyState title="Nothing needs action" subtitle="No flagged works match these filters for this scope." />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
