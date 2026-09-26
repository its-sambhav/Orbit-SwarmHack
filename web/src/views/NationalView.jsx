import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, formatRupees, buildSearchIndex, mapCategoryBreakdown } from '../api'
import { MospiNav } from '../components/MospiNav'
import { ProjectLifecycleBarChart } from '../components/ProjectLifecycleBarChart'
import { PipelineCard } from '../components/PipelineCard'
import { TagBreakdownCard } from '../components/TagBreakdownCard'
import { EntityRiskPanel } from '../components/EntityRiskPanel'
import { StatCard } from '../components/StatCard'
import { kpiCards } from '../kpiCards'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView } from '../components/StateViews'
import { useLanguage } from '../i18n'

const DEFAULT_SCOPE = '18th Lok Sabha'
const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)


function scrollToId(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export function NationalView() {
  const navigate = useNavigate()
  const { t, td } = useLanguage()
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

  // the SIH26102 cards (api/kpis.py, built by ../kpiCards.js): money at risk
  // and the alerts behind it, early warning, delays against the guideline
  // limits, missing completion evidence and fund use - a 2-column x 4-row
  // matrix. Money at risk opens the anomalies queue; a card whose works the
  // queue can list exactly opens it filtered to them.
  const openQueue = (filter) => () => navigate(`/anomalies?${new URLSearchParams({ scope, ...filter })}`)
  const cards = funnel ? [
    ...kpiCards(['moneyAtRisk', 'highSeverity', 'costOverruns', 'duplicates', 'earlyWarning', 'delayed', 'evidenceMissing'], funnel.kpis, { t, td }, {
      moneyAtRisk: { onClick: openQueue({}), hint: 'queue' },
      highSeverity: { onClick: openQueue({ severity: 'high' }), hint: 'works' },
      costOverruns: { onClick: openQueue({ tag: 'Unusual Cost' }), hint: 'works' },
      evidenceMissing: { onClick: openQueue({ tag: 'Completion Evidence Not Attached' }), hint: 'works' },
    }),
    {
      kind: 'fundUtilisation',
      label: 'Fund utilisation',
      value: funnel.allocated ? `${((funnel.paid / funnel.allocated) * 100).toFixed(0)}%` : '—',
      sub: t('{paid} of {allocated} allocated', { paid: formatRupees(funnel.paid), allocated: formatRupees(funnel.allocated) }),
    },
  ] : []


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
        subtitle={t('MoSPI · National Oversight · {scope}', { scope: t(scopeLabel(scope)) })}
        scopeWorksTotal={funnel?.total_works}
        searchIndex={searchIndex}
        drawerLinks={[
          { label: 'Overview', onClick: () => scrollToId('mospi-overview') },
          { label: 'Map', onClick: () => navigate('/mospi/map') },
          { label: 'Anomalies', onClick: () => navigate('/anomalies') },
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />

      <div className="mospi-body" id="report-capture">
        <div className="mospi-header-row">
          <h1 className="mospi-page-title">{t('India')}</h1>
          <div className="report-toolbar">
            <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
            <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
            <GenerateReportButton level="overview" scope={scope} dateFrom={dateFrom} dateTo={dateTo} title={`Overview — ${scopeLabel(scope)}`} summary={funnel} />
          </div>
        </div>

        <div className="mospi-stats" id="mospi-overview">
          {cards.length ? cards.map((c) => (
            <StatCard
              key={c.kind} label={c.label} value={c.value} sub={c.sub}
              description={c.description} onClick={c.onClick}
            />
          )) : Array.from({ length: 8 }).map((_, i) => (
            <div className="mospi-stat-card" key={i}><Loading label="" /></div>
          ))}
        </div>

        <button type="button" className="mospi-map-cta" onClick={() => navigate('/mospi/map')}>
          <div>
            <div className="mospi-map-cta-title">{t('Open the India risk map')}</div>
            <div className="mospi-map-cta-sub">{t('Constituency-level choropleth, {scope}', { scope: t(scopeLabel(scope)) })}</div>
          </div>
          <span className="mospi-map-cta-arrow">→</span>
        </button>

        <div className="mospi-charts-grid" id="mospi-analytics">
          {analytics && funnel && states ? (
            <>
              <ProjectLifecycleBarChart title="Project Lifecycle & Risk Breakdown" sectors={lifecycleSectors} />
              <TagBreakdownCard summary={analytics.tag_summary} linkQuery={{ scope }} />
              <EntityRiskPanel
                entities={stateEntities}
                entityType="States & UTs"
                entityLabel="State / UT"
                title="Top states by risk"
                onSelect={(s) => navigate(`/mospi/map?state=${encodeURIComponent(s.name)}`)}
              />
              <PipelineCard pipeline={funnel.pipeline} />
            </>
          ) : Array.from({ length: 4 }).map((_, i) => <div className="chart-card" key={i}><Loading label="Loading analytics" /></div>)}
        </div>
      </div>
    </div>
  )
}
