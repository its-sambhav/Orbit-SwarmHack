import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees, mapCategoryBreakdown } from '../api'
import { MospiNav } from '../components/MospiNav'
import { ProjectLifecycleBarChart } from '../components/ProjectLifecycleBarChart'
import { RankChart } from '../components/RankChart'
import { DonutCard } from '../components/DonutCard'
import { EntityRiskPanel } from '../components/EntityRiskPanel'
import { Breadcrumb } from '../components/Breadcrumb'
import { TAG_COLOR_KEY } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)
const STAGE_LABEL = { recommendation: 'Recommendation', sanction: 'Sanction', execution: 'Execution', payment: 'Payment' }

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

  // same 8 KPI fields MoSPI's own overview leads with (NationalView.jsx),
  // scoped to this state's own scorecard instead of the national funnel.
  const cards = data ? [
    { label: 'Total works', value: data.scorecard.works_total.toLocaleString('en-IN'), sub: formatRupees(data.scorecard.allocated) },
    { label: 'Recommended', value: data.scorecard.recommended_count.toLocaleString('en-IN'), sub: formatRupees(data.scorecard.recommended) },
    { label: 'Sanctioned', value: data.scorecard.sanctioned_count.toLocaleString('en-IN'), sub: formatRupees(data.scorecard.sanctioned) },
    { label: 'Completed', value: data.scorecard.completed_count.toLocaleString('en-IN'), sub: formatRupees(data.scorecard.completed) },
    {
      label: 'Fund utilisation',
      value: data.scorecard.allocated ? `${((data.scorecard.paid / data.scorecard.allocated) * 100).toFixed(0)}%` : '—',
      sub: `${formatRupees(data.scorecard.paid)} of ${formatRupees(data.scorecard.allocated)} allocated`,
    },
    {
      label: 'Completion rate',
      value: data.scorecard.completion_rate != null ? `${data.scorecard.completion_rate.toFixed(0)}%` : '—',
      sub: `${data.scorecard.completed_count.toLocaleString('en-IN')} of ${data.scorecard.sanctioned_count.toLocaleString('en-IN')} sanctioned works`,
    },
    {
      label: 'Pending works',
      value: data.scorecard.ongoing.toLocaleString('en-IN'),
      sub: 'Sanctioned, not yet completed',
    },
    {
      label: 'Avg. cost / completed work',
      value: formatRupees(data.scorecard.completed_count ? data.scorecard.completed / data.scorecard.completed_count : 0),
      sub: `Across ${data.scorecard.completed_count.toLocaleString('en-IN')} completed works`,
    },
  ] : []

  const tagItems = data
    ? Object.entries(data.tag_breakdown).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))
    : []
  const tagColor = (item) => (TAG_COLOR_KEY[item.label] ? `var(--tag-${TAG_COLOR_KEY[item.label]})` : 'var(--ink-faint)')
  const stageItems = data?.funnel ? [
    { label: STAGE_LABEL.recommendation, value: data.funnel.recommended || 0 },
    { label: STAGE_LABEL.sanction, value: data.funnel.sanctioned || 0 },
    { label: STAGE_LABEL.execution, value: Math.max(0, (data.funnel.sanctioned || 0) - (data.funnel.completed || 0)) },
    { label: STAGE_LABEL.payment, value: data.funnel.completed || 0 },
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
        subtitle={`State Nodal Authority · ${data.state}`}
        searchIndex={[]}
        showSearch={false}
        profileName={data.state}
        profileRole="State Nodal Authority"
        avatarLetter="S"
        drawerLinks={[
          { label: 'Map', onClick: () => navigate(mapUrl) },
        ]}
      />
      <div className="mospi-body" id="report-capture">
        <div className="report-toolbar">
          <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
          <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
          <GenerateReportButton
            level="state" scope={scope} dateFrom={dateFrom} dateTo={dateTo} state={data.state}
            title={`${data.state} — ${scopeLabel(scope)}`} summary={data.scorecard}
          />
        </div>

        <div className="map-drill-header" style={{ marginBottom: 18 }}>
          <Breadcrumb items={[{ label: data.state }]} />
          <h1 style={{ margin: '4px 0 2px' }}>{data.state}</h1>
          <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
            State Nodal Authority · {scopeLabel(scope)}
          </div>
        </div>

        <div className="mospi-stats">
          {cards.map((c) => (
            <div className="mospi-stat-card" key={c.label}>
              <div className="mospi-stat-label">{c.label}</div>
              <div className="mospi-stat-value num">{c.value}</div>
              <div className="mospi-stat-amount num">{c.sub}</div>
            </div>
          ))}
        </div>

        <button type="button" className="mospi-map-cta" onClick={() => navigate(mapUrl)}>
          <div>
            <div className="mospi-map-cta-title">View the constituency map</div>
            <div className="mospi-map-cta-sub">Constituency-level choropleth for {data.state}, {scopeLabel(scope)}</div>
          </div>
          <span className="mospi-map-cta-arrow">→</span>
        </button>

        <div className="mospi-charts-grid">
          <ProjectLifecycleBarChart title={`Project Lifecycle & Risk Breakdown — ${data.state}`} sectors={lifecycleSectors} />
          <DonutCard title="Findings by tag" items={tagItems} colorFor={tagColor} />
          <EntityRiskPanel
            entities={districtEntities}
            entityType="Districts"
            onSelect={(d) => navigate(`/district/${encodeURIComponent(data.state)}/${encodeURIComponent(d.name)}?scope=${encodeURIComponent(scope)}&role=state&role_name=${encodeURIComponent(data.state)}`)}
          />
          <RankChart title="Works by pipeline stage" items={stageItems} />
        </div>
      </div>
    </div>
  )
}
