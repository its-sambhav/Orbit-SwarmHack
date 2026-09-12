import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
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

// the content here is identical either way a district is reached - MoSPI's
// own India > State > District drill-down (/district/...) and the District
// Authority role (/district-authority/..., picked from RoleSelector) show
// the same data. Only the chrome differs: the role has no authorized access
// to MoSPI's search or its Overview/Reports pages, so isRoleView turns those
// off rather than forking an otherwise-identical second file.
//
// Overview/Map split - same as StateView.jsx/StateMapView.jsx: this page is
// stats+charts only, the anomaly heatmap + pending-action queue live at
// their own route, DistrictMapView.jsx (/district(-authority)/.../map).
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

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading district" />

  const lifecycleSectors = mapCategoryBreakdown(data.category_breakdown)

  // same 8 KPI fields MoSPI's own overview leads with (NationalView.jsx),
  // scoped to this district's own scorecard.
  const cards = [
    { label: 'Recommended', value: data.scorecard.recommended_count.toLocaleString('en-IN'), sub: formatRupees(data.scorecard.recommended) },
    { label: 'Sanctioned', value: data.scorecard.sanctioned_count.toLocaleString('en-IN'), sub: formatRupees(data.scorecard.sanctioned) },
    { label: 'Completed', value: data.scorecard.completed_count.toLocaleString('en-IN'), sub: formatRupees(data.scorecard.completed) },
    { label: 'Works flagged', value: data.scorecard.works_flagged.toLocaleString('en-IN'), sub: `of ${data.scorecard.works_total.toLocaleString('en-IN')} total works` },
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
  ]

  const tagItems = Object.entries(data.tag_breakdown).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))
  const tagColor = (item) => (TAG_COLOR_KEY[item.label] ? `var(--tag-${TAG_COLOR_KEY[item.label]})` : 'var(--ink-faint)')
  const stageItems = data.funnel ? [
    { label: STAGE_LABEL.recommendation, value: data.funnel.recommended || 0 },
    { label: STAGE_LABEL.sanction, value: data.funnel.sanctioned || 0 },
    { label: STAGE_LABEL.execution, value: Math.max(0, (data.funnel.sanctioned || 0) - (data.funnel.completed || 0)) },
    { label: STAGE_LABEL.payment, value: data.funnel.completed || 0 },
  ] : []

  // EntityRiskPanel's generic {name, works_total, works_flagged, breach_rate,
  // risk_score} shape - a district has no further sub-jurisdiction of its
  // own, so its own agency_performance list (already computed server-side)
  // fills that slot instead, with each agency's own delayed-work count/rate
  // standing in for works_flagged/breach_rate (agency_performance has no
  // true risk_score - there's nothing else on it that plays that role).
  const agencyEntities = data.agency_performance.map((a) => ({
    name: a.agency,
    works_total: a.works_total,
    works_flagged: a.delayed,
    breach_rate: a.works_total ? a.delayed / a.works_total : 0,
    risk_score: a.delayed,
  }))

  const mapUrl = `${isRoleView ? `/district-authority/${encodeURIComponent(stateName)}/${encodeURIComponent(districtName)}` : `/district/${encodeURIComponent(stateName)}/${encodeURIComponent(districtName)}`}/map?${params.toString()}`

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
          { label: 'Map', onClick: () => navigate(mapUrl) },
        ] : [
          { label: 'Overview', onClick: () => navigate('/mospi') },
          { label: 'Map', onClick: () => navigate(mapUrl) },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />
      <div className="mospi-body" id="report-capture">
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

        <div className="map-drill-header" style={{ marginBottom: 18 }}>
          <Breadcrumb items={isRoleView ? [{ label: data.district }] : [
            { label: data.state, to: `/mospi/map?state=${encodeURIComponent(data.state)}` },
            { label: data.district },
          ]} />
          <h1 style={{ margin: '4px 0 2px' }}>{data.district}</h1>
          <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
            District Authority · {data.state} · {scopeLabel(scope)}
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
            <div className="mospi-map-cta-title">View the anomaly map</div>
            <div className="mospi-map-cta-sub">Constituency-level heatmap for {data.district}, {scopeLabel(scope)}</div>
          </div>
          <span className="mospi-map-cta-arrow">→</span>
        </button>

        <div className="mospi-charts-grid">
          <ProjectLifecycleBarChart title={`Project Lifecycle & Risk Breakdown — ${data.district}`} sectors={lifecycleSectors} />
          <DonutCard title="Findings by tag" items={tagItems} colorFor={tagColor} />
          <EntityRiskPanel
            entities={agencyEntities}
            entityType="Agencies"
            onSelect={(a) => navigate(`/agency/${encodeURIComponent(a.name)}?scope=${encodeURIComponent(scope)}`)}
          />
          <RankChart title="Works by pipeline stage" items={stageItems} />
        </div>
      </div>
    </div>
  )
}
