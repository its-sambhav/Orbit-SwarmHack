import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees, mapCategoryBreakdown } from '../api'
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

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)

function scrollToId(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// State Authority's own Overview - the same split MoSPI's own dashboard uses
// (NationalView is stats+charts only; its map is a separate page,
// MospiMapView.jsx, one click away via a CTA) rather than one page that
// scrolls from KPIs into an embedded map. The constituency map + anomalies
// queue live at their own route, StateMapView.jsx (/state/:name/map).
export function StateView() {
  const { stateName } = useParams()
  const [params, setSearchParams] = useSearchParams()
  const scope = params.get('scope') || '18th Lok Sabha'
  const dateFrom = params.get('date_from') || null
  const dateTo = params.get('date_to') || null
  const navigate = useNavigate()
  const { t, td } = useLanguage()
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => { api.meta().then(setMeta).catch(() => {}) }, [])

  useEffect(() => {
    setData(null)
    api.state(stateName, scope, { dateFrom, dateTo }).then(setData).catch((e) => setError(e.message))
  }, [stateName, scope, dateFrom, dateTo])

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

  const lifecycleSectors = mapCategoryBreakdown(data?.category_breakdown)

  // the same cards as MoSPI's own overview (NationalView.jsx), scoped to this
  // state - each hover explainer names the district with the most.
  const cards = data ? [
    ...kpiCards(['moneyAtRisk', 'highSeverity', 'costOverruns', 'duplicates', 'earlyWarning', 'delayed', 'evidenceMissing'], data.kpis, { t, td }, {
      moneyAtRisk: {
        onClick: () => navigate(`/anomalies?state=${encodeURIComponent(data.state)}&scope=${encodeURIComponent(scope)}`),
        hint: 'queue',
      },
    }),
    {
      kind: 'fundUtilisation',
      label: 'Fund utilisation',
      value: data.scorecard.allocated ? `${((data.scorecard.paid / data.scorecard.allocated) * 100).toFixed(0)}%` : '—',
      sub: t('{paid} of {allocated} allocated', { paid: formatRupees(data.scorecard.paid), allocated: formatRupees(data.scorecard.allocated) }),
    },
  ] : []


  // EntityRiskPanel's generic {name, works_total, works_flagged,
  // breach_rate, risk_score} shape - data.districts already has every one
  // of these fields, just keyed "district" instead of "name".
  const districtEntities = data?.districts ? data.districts.map((d) => ({ ...d, name: d.district })) : []

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading state" />

  const mapUrl = `/state/${encodeURIComponent(data.state)}/map?${params.toString()}`

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={t('State Nodal Authority · {state}', { state: td(data.state) })}
        searchIndex={[]}
        showSearch={false}
        profileName={data.state}
        profileRole="State Nodal Authority"
        avatarLetter="S"
        drawerLinks={[
          { label: 'Overview', onClick: () => scrollToId('mospi-overview') },
          { label: 'Map', onClick: () => navigate(mapUrl) },
          { label: 'Anomalies', onClick: () => navigate(`/anomalies?state=${encodeURIComponent(data.state)}&scope=${encodeURIComponent(scope)}`) },
        ]}
      />
      <div className="mospi-body" id="report-capture">
        <div className="map-drill-header" style={{ marginBottom: 18 }}>
          <div className="mospi-header-row">
            <h1 style={{ margin: 0 }}>{td(data.state)}</h1>
            <div className="report-toolbar">
              <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
              <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
              <GenerateReportButton
                level="state" scope={scope} dateFrom={dateFrom} dateTo={dateTo} state={data.state}
                title={`${data.state} — ${scopeLabel(scope)}`} summary={data.scorecard}
              />
            </div>
          </div>
        </div>

        <div className="mospi-stats" id="mospi-overview">
          {cards.map((c) => (
            <StatCard
              key={c.kind} label={c.label} value={c.value} sub={c.sub}
              description={c.description} onClick={c.onClick}
            />
          ))}
        </div>

        <button type="button" className="mospi-map-cta" onClick={() => navigate(mapUrl)}>
          <div>
            <div className="mospi-map-cta-title">{t('View the constituency map')}</div>
            <div className="mospi-map-cta-sub">{t('Constituency-level choropleth for {name}, {scope}', { name: td(data.state), scope: t(scopeLabel(scope)) })}</div>
          </div>
          <span className="mospi-map-cta-arrow">→</span>
        </button>

        <div className="mospi-charts-grid">
          <ProjectLifecycleBarChart title={t('Project Lifecycle & Risk Breakdown — {name}', { name: td(data.state) })} sectors={lifecycleSectors} />
          <TagBreakdownCard summary={data.tag_summary} linkQuery={{ scope, state: data.state }} />
          <EntityRiskPanel
            entities={districtEntities}
            entityType="Districts"
            onSelect={(d) => navigate(`/district/${encodeURIComponent(data.state)}/${encodeURIComponent(d.name)}?scope=${encodeURIComponent(scope)}&role=state&role_name=${encodeURIComponent(data.state)}`)}
          />
          <PipelineCard pipeline={data.pipeline} />
        </div>
      </div>
    </div>
  )
}
