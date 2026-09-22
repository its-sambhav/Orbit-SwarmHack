import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, formatRupees, buildSearchIndex, mapCategoryBreakdown } from '../api'
import { MospiNav } from '../components/MospiNav'
import { ProjectLifecycleBarChart } from '../components/ProjectLifecycleBarChart'
import { RankChart } from '../components/RankChart'
import { DonutCard } from '../components/DonutCard'
import { EntityRiskPanel } from '../components/EntityRiskPanel'
import { TAG_COLOR_KEY } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView } from '../components/StateViews'

const DEFAULT_SCOPE = '18th Lok Sabha'
const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)

const STAGE_LABEL = { recommendation: 'Recommendation', sanction: 'Sanction', execution: 'Execution', payment: 'Payment' }

function scrollToId(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export function NationalView() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const dateFrom = searchParams.get('date_from') || null
  const dateTo = searchParams.get('date_to') || null
  const scope = searchParams.get('scope') || DEFAULT_SCOPE
  const [funnel, setFunnel] = useState(null)
  const [analytics, setAnalytics] = useState(null)
  const [constituencies, setConstituencies] = useState(null)
  const [states, setStates] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.meta().then(setMeta).catch(() => {})
  }, [])

  useEffect(() => {
    api.constituencies(scope).then(setConstituencies).catch((e) => setError(e.message))
  }, [scope])

  useEffect(() => {
    api.funnel(scope, { dateFrom, dateTo }).then(setFunnel).catch((e) => setError(e.message))
    api.analytics(scope, { dateFrom, dateTo }).then(setAnalytics).catch((e) => setError(e.message))
    // full state/UT coverage for the states panel - /api/states, not the
    // analytics endpoint's top-5-only slice.
    api.states({ scope }, { dateFrom, dateTo }).then((r) => setStates(r.items)).catch((e) => setError(e.message))
  }, [scope, dateFrom, dateTo])

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

  const searchIndex = useMemo(() => buildSearchIndex(constituencies), [constituencies])

  // financial-health cards lead, the original volume cards follow - a 2-column
  // x 4-row matrix rather than 8 cards jammed into one row.
  const cards = funnel ? [
    { label: 'Recommended', value: funnel.recommended.toLocaleString('en-IN'), sub: formatRupees(funnel.recommended_amount) },
    { label: 'Sanctioned', value: funnel.sanctioned.toLocaleString('en-IN'), sub: formatRupees(funnel.sanctioned_amount) },
    { label: 'Completed', value: funnel.completed.toLocaleString('en-IN'), sub: formatRupees(funnel.completed_amount) },
    { label: 'Works flagged', value: funnel.works_flagged.toLocaleString('en-IN'), sub: `of ${funnel.total_works.toLocaleString('en-IN')} total works` },
    {
      label: 'Fund utilisation',
      value: funnel.allocated ? `${((funnel.paid / funnel.allocated) * 100).toFixed(0)}%` : '—',
      sub: `${formatRupees(funnel.paid)} of ${formatRupees(funnel.allocated)} allocated`,
    },
    {
      label: 'Completion rate',
      value: funnel.completion_rate != null ? `${funnel.completion_rate.toFixed(0)}%` : '—',
      sub: `${funnel.completed.toLocaleString('en-IN')} of ${funnel.sanctioned.toLocaleString('en-IN')} sanctioned works`,
    },
    {
      label: 'Pending works',
      value: funnel.sanctioned_never_completed.toLocaleString('en-IN'),
      sub: 'Sanctioned, not yet completed',
    },
    {
      label: 'Avg. cost / completed work',
      value: formatRupees(funnel.completed ? funnel.completed_amount / funnel.completed : 0),
      sub: `Across ${funnel.completed.toLocaleString('en-IN')} completed works`,
    },
  ] : []

  const tagItems = analytics
    ? Object.entries(analytics.tag_counts).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))
    : []
  const tagColor = (item) => (TAG_COLOR_KEY[item.label] ? `var(--tag-${TAG_COLOR_KEY[item.label]})` : 'var(--ink-faint)')
  const stageItems = analytics
    ? Object.entries(STAGE_LABEL).map(([k, label]) => ({ label, value: analytics.stage_counts[k] || 0 }))
    : []

  // real per-sector-category counts + financial exposure, from the same
  // /api/funnel response the KPI cards above already use - see
  // api/sector_categories.py for what the 5 categories are and how each
  // work's real activity is mapped onto one of them.
  const lifecycleSectors = mapCategoryBreakdown(funnel?.category_breakdown)

  // EntityRiskPanel's own generic {name, works_total, works_flagged,
  // breach_rate, risk_score} shape - states already has every one of these
  // fields, just under the field name "state" instead of "name".
  const stateEntities = useMemo(
    () => (states ? states.map((s) => ({ ...s, name: s.state })) : []),
    [states]
  )

  if (error) return <ErrorView message={error} onRetry={() => window.location.reload()} />

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={`MoSPI · National Oversight · ${scopeLabel(scope)}`}
        scopeWorksTotal={funnel?.total_works}
        searchIndex={searchIndex}
        drawerLinks={[
          { label: 'Overview', onClick: () => scrollToId('mospi-overview') },
          { label: 'Map', onClick: () => navigate('/mospi/map') },
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />

      <div className="mospi-body" id="report-capture">
        <div className="report-toolbar">
          <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
          <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
          <GenerateReportButton level="overview" scope={scope} dateFrom={dateFrom} dateTo={dateTo} title={`Overview — ${scopeLabel(scope)}`} summary={funnel} />
        </div>

        <div className="mospi-stats" id="mospi-overview">
          {cards.length ? cards.map((c) => (
            <div className="mospi-stat-card" key={c.label}>
              <div className="mospi-stat-label">{c.label}</div>
              <div className="mospi-stat-value num">{c.value}</div>
              <div className="mospi-stat-amount num">{c.sub}</div>
            </div>
          )) : Array.from({ length: 8 }).map((_, i) => (
            <div className="mospi-stat-card" key={i}><Loading label="" /></div>
          ))}
        </div>

        <button type="button" className="mospi-map-cta" onClick={() => navigate('/mospi/map')}>
          <div>
            <div className="mospi-map-cta-title">Open the India risk map</div>
            <div className="mospi-map-cta-sub">Constituency-level choropleth, {scopeLabel(scope)}</div>
          </div>
          <span className="mospi-map-cta-arrow">→</span>
        </button>

        <div className="mospi-charts-grid" id="mospi-analytics">
          {analytics && funnel && states ? (
            <>
              <ProjectLifecycleBarChart title="Project Lifecycle & Risk Breakdown" sectors={lifecycleSectors} />
              <DonutCard title="Findings by tag" items={tagItems} colorFor={tagColor} />
              <EntityRiskPanel
                entities={stateEntities}
                entityType="States & UTs"
                entityLabel="State / UT"
                title="Top states by risk"
                onSelect={(s) => navigate(`/mospi/map?state=${encodeURIComponent(s.name)}`)}
              />
              <RankChart title="Works by pipeline stage" items={stageItems} />
            </>
          ) : Array.from({ length: 4 }).map((_, i) => <div className="chart-card" key={i}><Loading label="Loading analytics" /></div>)}
        </div>
      </div>
    </div>
  )
}
