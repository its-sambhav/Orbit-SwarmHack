import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees, mapCategoryBreakdown } from '../api'
import { MospiNav } from '../components/MospiNav'
import { ProjectLifecycleBarChart } from '../components/ProjectLifecycleBarChart'
import { RankChart } from '../components/RankChart'
import { DonutCard } from '../components/DonutCard'
import { StatCard } from '../components/StatCard'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip, TAG_COLOR_KEY } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'
import { useLanguage } from '../i18n'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)

function scrollToId(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

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
  const { t, td } = useLanguage()
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)
  const [severityFilter, setSeverityFilter] = useState('')
  const [stateFilter, setStateFilter] = useState('')

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

  // no "Recommended" bar - allocation/recommendation is a per-MP figure an
  // implementing agency doesn't have (see data.scorecard's own API comment),
  // so it's zeroed out here even though the shared category_breakdown
  // technically has a real (agency-meaningless) number for it.
  const lifecycleSectors = mapCategoryBreakdown(data.category_breakdown)
    .map((c) => ({ ...c, recommended: 0, recommended_cr: 0 }))

  // an implementing agency has no allocated/recommended figure of its own
  // (see the comment above and data.scorecard's own shape) - the 8-KPI row
  // substitutes Works flagged and Completion rate for MoSPI's own Fund
  // Utilisation/Recommended cards rather than showing a field this role
  // doesn't have.
  const completionRate = data.scorecard.sanctioned_count
    ? (data.scorecard.completed_count / data.scorecard.sanctioned_count) * 100
    : null
  const cards = [
    {
      label: 'Avg. cost / completed work',
      value: data.scorecard.completed_count ? formatRupees(data.scorecard.completed / data.scorecard.completed_count) : '—',
      sub: t('Across {n} completed works', { n: data.scorecard.completed_count.toLocaleString('en-IN') }),
    },
    {
      label: 'Completion rate',
      value: completionRate != null ? `${completionRate.toFixed(0)}%` : '—',
      sub: t('{n} delayed', { n: data.scorecard.delayed.toLocaleString('en-IN') }),
    },
    { label: 'Sanctioned', value: data.scorecard.sanctioned_count.toLocaleString('en-IN'), sub: formatRupees(data.scorecard.sanctioned) },
    {
      label: 'Works flagged',
      value: data.scorecard.works_flagged.toLocaleString('en-IN'),
      sub: t('of {n} total works', { n: data.scorecard.works_total.toLocaleString('en-IN') }),
    },
    { label: 'Completed', value: data.scorecard.completed_count.toLocaleString('en-IN'), sub: formatRupees(data.scorecard.completed) },
    { label: 'Paid', value: data.scorecard.paid_count.toLocaleString('en-IN'), sub: formatRupees(data.scorecard.paid) },
    { label: 'Pending works', value: data.scorecard.ongoing.toLocaleString('en-IN'), sub: t('Sanctioned, not yet completed') },
  ]

  const tagItems = Object.entries(data.tag_breakdown).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))
  const tagColor = (item) => (TAG_COLOR_KEY[item.label] ? `var(--tag-${TAG_COLOR_KEY[item.label]})` : 'var(--ink-faint)')
  // an agency's own work starts at Sanction, not Recommendation - the same
  // 4-stage Recommendation/Sanction/Execution/Payment breakdown the other
  // roles use doesn't apply here, so this uses the 3 stages this role's own
  // scorecard actually tracks instead of forcing a stage it has no data for.
  const stageItems = [
    { label: 'Sanctioned', value: data.scorecard.sanctioned_count },
    { label: 'Ongoing', value: data.scorecard.ongoing },
    { label: 'Completed', value: data.scorecard.completed_count },
  ]

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={t('Implementing Agency · {agency}', { agency: td(data.agency) })}
        searchIndex={[]}
        showSearch={false}
        profileName={data.agency}
        profileRole="Implementing Agency"
        avatarLetter="A"
        drawerLinks={[]}
      />
      <div className="mospi-map-page-body" id="report-capture">
        <div className="map-drill-view" style={{ padding: 0, height: '100%' }}>
          <div className="map-drill-header">
            <Breadcrumb items={[{ label: data.agency }]} />
            <h1 style={{ margin: '4px 0 2px' }}>{td(data.agency)}</h1>
            <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
              {t('Implementing Agency · {scope}', { scope: t(scopeLabel(scope)) })}
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
            {td(data.data_caveat)}
          </p>

          <div className="mospi-stats">
            {cards.map((c) => (
              <StatCard
                key={c.label} label={c.label} value={c.value} sub={c.sub}
                onClick={c.label === 'Works flagged' ? () => scrollToId('agency-assigned-works') : undefined}
              />
            ))}
          </div>

          <div className="mospi-charts-grid">
            <ProjectLifecycleBarChart title={t('Project Lifecycle & Risk Breakdown — {name}', { name: td(data.agency) })} sectors={lifecycleSectors} />
            <DonutCard title="Findings by tag" items={tagItems} colorFor={tagColor} />
            <RankChart title="Works by stage" items={stageItems} />
          </div>

          <div className="map-drill-row map-drill-row-2col">
            <div className="map-drill-details">
              <h3>{t('States touched')}</h3>
              {data.states_touched.map((s) => <p key={s} className="fact-line">{td(s)}</p>)}

              <h3>{t('By tag')}</h3>
              <div className="tag-breakdown">
                {Object.entries(data.tag_breakdown).map(([tag, n]) => (
                  <div key={tag} className="tag-breakdown-row"><TagChip tag={tag} /><span className="num">{n.toLocaleString('en-IN')}</span></div>
                ))}
              </div>
            </div>

            <div className="map-drill-findings" id="agency-assigned-works">
              <h3>{t('Assigned works ({n})', { n: filteredQueue.length })}</h3>
              <div className="filters" style={{ marginBottom: 10 }}>
                <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
                  <option value="">{t('All severities')}</option>
                  <option value="high">{t('High')}</option>
                  <option value="medium">{t('Medium')}</option>
                  <option value="low">{t('Low')}</option>
                </select>
                <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                  <option value="">{t('All states')}</option>
                  {data.states_touched.map((s) => <option key={s} value={s}>{td(s)}</option>)}
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
                        <span className="queue-item-title">{td(item.constituency)}, {td(item.state)}</span>
                        <span className="queue-item-amount num">{formatRupees(item.total_exposure)}</span>
                      </div>
                      {item.headline && <p className="queue-item-headline">{td(item.headline)}</p>}
                      <div className="queue-item-meta">{[item.mp_name && td(item.mp_name), t('Work #{n}', { n: item.work_number }), item.routed_to && t(item.routed_to)].filter(Boolean).join(' · ')}</div>
                      <div className="queue-item-chips">
                        <SeverityChip severity={item.max_severity} />
                        {item.tags.map((tag) => <TagChip key={tag} tag={tag} />)}
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
