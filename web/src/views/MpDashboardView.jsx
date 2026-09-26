import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees, mapCategoryBreakdown } from '../api'
import { MospiNav } from '../components/MospiNav'
import { ProjectLifecycleBarChart } from '../components/ProjectLifecycleBarChart'
import { PipelineCard } from '../components/PipelineCard'
import { TagBreakdownCard } from '../components/TagBreakdownCard'
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
  const { t, td } = useLanguage()
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

  const mapUrl = `/mp/${encodeURIComponent(mpName)}/map?${params.toString()}`

  // an MP's own cards (api/kpis.py): fund use and assets delivered, how their
  // recommendations move against the guideline limits, and how many of their
  // works carry risk - the flagged share read against their state's.
  const cards = [
    {
      kind: 'fundUtilisation',
      label: 'Fund utilisation',
      value: scorecard.allocated ? `${((scorecard.paid / scorecard.allocated) * 100).toFixed(0)}%` : '—',
      sub: t('{paid} of {allocated} allocated', { paid: formatRupees(scorecard.paid), allocated: formatRupees(scorecard.allocated) }),
    },
    ...kpiCards(['assetsDelivered', 'sanctionBacklog', 'overdue', 'daysToSanction', 'earlyWarning', 'flaggedShare',
      'costAndDuplicates'], data.kpis, { t, td }, {
      flaggedShare: { onClick: () => navigate(mapUrl), hint: 'map' },
    }),
  ]

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={t('Member of Parliament · {mp}', { mp: td(data.mp_name) })}
        searchIndex={[]}
        showSearch={false}
        profileName={data.mp_name}
        profileRole="Member of Parliament"
        avatarLetter="M"
        drawerLinks={[
          { label: 'Overview', onClick: () => scrollToId('mospi-overview') },
          { label: 'Map', onClick: () => navigate(mapUrl) },
          { label: 'Works', onClick: () => navigate(`/mp/${encodeURIComponent(mpName)}/works?${params.toString()}`) },
        ]}
      />
      <div className="mospi-body" id="report-capture">
        <div className="map-drill-header" style={{ marginBottom: 18 }}>
          <div className="mospi-header-row">
            <h1 style={{ margin: 0 }}>{td(data.mp_name)}</h1>
            <div className="report-toolbar">
              <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
              <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
              <GenerateReportButton
                level="mp" scope={scope} dateFrom={dateFrom} dateTo={dateTo}
                title={`${data.mp_name} — ${scopeLabel(scope)}`} summary={scorecard}
              />
            </div>
          </div>
          <div className="mospi-header-meta">
            {td(data.constituency)}, {td(data.state)} · {t(scopeLabel(scope))} · {t(data.status)}
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
            <div className="mospi-map-cta-sub">{td(data.constituency)}, {t(scopeLabel(scope))}</div>
          </div>
          <span className="mospi-map-cta-arrow">→</span>
        </button>

        <div className="mospi-charts-grid">
          <ProjectLifecycleBarChart title={t('Project Lifecycle & Risk Breakdown — {name}', { name: td(data.constituency) })} sectors={lifecycleSectors} />
          <TagBreakdownCard summary={data.tag_summary} linkQuery={{ scope, state: data.state }} />
          <PipelineCard pipeline={data.pipeline} />
        </div>
      </div>
    </div>
  )
}
