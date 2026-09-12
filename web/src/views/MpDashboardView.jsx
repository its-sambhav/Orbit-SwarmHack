import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees, mapCategoryBreakdown } from '../api'
import { MospiNav } from '../components/MospiNav'
import { ProjectLifecycleBarChart } from '../components/ProjectLifecycleBarChart'
import { RankChart } from '../components/RankChart'
import { DonutCard } from '../components/DonutCard'
import { Breadcrumb } from '../components/Breadcrumb'
import { TAG_COLOR_KEY } from '../components/Chips'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)
const PIPELINE_STAGE_LABEL = { recommendation: 'Recommendation', sanction: 'Sanction', execution: 'Execution', payment: 'Payment' }

// The MP's own dashboard - constituency development and recommendations,
// not administrative execution. Shows the FULL recommended-works portfolio
// (api.mp already returns every work, not just flagged ones) with
// "under review" language for flagged items, not MoSPI's audit-toned
// "Findings"/evidence-table framing - that distinction is the whole point
// of this being a separate view from ConstituencyView/MoSPI's own page.
//
// Overview/Map split - same as StateView.jsx/StateMapView.jsx: this page is
// stats+charts only, the constituency map + recommended-works list live at
// their own route, MpMapView.jsx (/mp/:id/map).
export function MpDashboardView() {
  const { id: mpName } = useParams()
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

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading MP dashboard" />

  const { scorecard } = data
  const lifecycleSectors = mapCategoryBreakdown(data.category_breakdown)

  // same 8 KPI fields MoSPI's own overview leads with (NationalView.jsx),
  // scoped to this MP's own scorecard.
  const cards = [
    { label: 'Recommended', value: scorecard.recommended_count.toLocaleString('en-IN'), sub: formatRupees(scorecard.recommended) },
    { label: 'Sanctioned', value: scorecard.sanctioned_count.toLocaleString('en-IN'), sub: formatRupees(scorecard.sanctioned) },
    { label: 'Completed', value: scorecard.completed_count.toLocaleString('en-IN'), sub: formatRupees(scorecard.completed) },
    { label: 'Works flagged', value: scorecard.works_flagged.toLocaleString('en-IN'), sub: `of ${scorecard.works_total.toLocaleString('en-IN')} total works` },
    {
      label: 'Fund utilisation',
      value: scorecard.allocated ? `${((scorecard.paid / scorecard.allocated) * 100).toFixed(0)}%` : '—',
      sub: `${formatRupees(scorecard.paid)} of ${formatRupees(scorecard.allocated)} allocated`,
    },
    {
      label: 'Completion rate',
      value: scorecard.completion_rate != null ? `${scorecard.completion_rate.toFixed(0)}%` : '—',
      sub: `${scorecard.completed_count.toLocaleString('en-IN')} of ${scorecard.sanctioned_count.toLocaleString('en-IN')} sanctioned works`,
    },
    {
      label: 'Pending works',
      value: scorecard.ongoing.toLocaleString('en-IN'),
      sub: 'Sanctioned, not yet completed',
    },
    {
      label: 'Avg. cost / completed work',
      value: formatRupees(scorecard.completed_count ? scorecard.completed / scorecard.completed_count : 0),
      sub: `Across ${scorecard.completed_count.toLocaleString('en-IN')} completed works`,
    },
  ]

  const tagItems = Object.entries(data.tag_breakdown).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))
  const tagColor = (item) => (TAG_COLOR_KEY[item.label] ? `var(--tag-${TAG_COLOR_KEY[item.label]})` : 'var(--ink-faint)')
  const stageItems = [
    { label: PIPELINE_STAGE_LABEL.recommendation, value: scorecard.recommended_count },
    { label: PIPELINE_STAGE_LABEL.sanction, value: scorecard.sanctioned_count },
    { label: PIPELINE_STAGE_LABEL.execution, value: Math.max(0, scorecard.sanctioned_count - scorecard.completed_count) },
    { label: PIPELINE_STAGE_LABEL.payment, value: scorecard.completed_count },
  ]

  const mapUrl = `/mp/${encodeURIComponent(mpName)}/map?${params.toString()}`

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
        drawerLinks={[
          { label: 'Map', onClick: () => navigate(mapUrl) },
        ]}
      />
      <div className="mospi-body" id="report-capture">
        <div className="report-toolbar">
          <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
          <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
          <GenerateReportButton
            level="mp" scope={scope} dateFrom={dateFrom} dateTo={dateTo}
            title={`${data.mp_name} — ${scopeLabel(scope)}`} summary={scorecard}
          />
        </div>

        <div className="map-drill-header" style={{ marginBottom: 18 }}>
          <Breadcrumb items={[{ label: data.mp_name }]} />
          <h1 style={{ margin: '4px 0 2px' }}>{data.mp_name}</h1>
          <div className="meta" style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
            {data.constituency}, {data.state} · {scopeLabel(scope)} · {data.status}
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
            <div className="mospi-map-cta-sub">{data.constituency}, {scopeLabel(scope)}</div>
          </div>
          <span className="mospi-map-cta-arrow">→</span>
        </button>

        <div className="mospi-charts-grid">
          <ProjectLifecycleBarChart title={`Project Lifecycle & Risk Breakdown — ${data.constituency}`} sectors={lifecycleSectors} />
          <DonutCard title="Findings by tag" items={tagItems} colorFor={tagColor} />
          <RankChart title="Works by pipeline stage" items={stageItems} />
        </div>
      </div>
    </div>
  )
}
