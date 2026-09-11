import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, formatRupees, buildSearchIndex } from '../api'
import { MospiNav } from '../components/MospiNav'
import { SEV_LABEL, TAG_COLOR_KEY } from '../components/Chips'
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

function RankChart({ title, items, colorFor, onSelect, formatValue }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <div className="rank-list rank-list-compact">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className="rank-item"
            disabled={!onSelect}
            onClick={onSelect ? () => onSelect(item) : undefined}
            title={`${item.label}: ${item.value.toLocaleString('en-IN')}`}
          >
            <span className="rank-item-name">{item.label}</span>
            <span className="rank-item-meta num">{formatValue ? formatValue(item) : item.value.toLocaleString('en-IN')}</span>
            <span className="rank-item-bar">
              <span style={{ width: `${Math.max((item.value / max) * 100, 3)}%`, background: colorFor ? colorFor(item) : undefined }} />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// part-of-whole distributions (severity, tag) read better as a donut than a
// bar rank - built on a CSS conic-gradient rather than pulling in a chart
// library for two charts.
function DonutCard({ title, items, colorFor, onSelect }) {
  const total = items.reduce((s, i) => s + i.value, 0)
  let acc = 0
  const stops = items.map((item) => {
    const from = total ? (acc / total) * 360 : 0
    acc += item.value
    const to = total ? (acc / total) * 360 : 0
    return `${colorFor(item)} ${from}deg ${to}deg`
  }).join(', ')
  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <div className="donut-row">
        <div className="donut-chart" style={{ background: total ? `conic-gradient(${stops})` : 'var(--surface-sunken)' }}>
          <div className="donut-hole">
            <span className="donut-hole-value num">{total.toLocaleString('en-IN')}</span>
            <span className="donut-hole-label">total</span>
          </div>
        </div>
        <div className="donut-legend">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              className="donut-legend-row"
              disabled={!onSelect}
              onClick={onSelect ? () => onSelect(item) : undefined}
            >
              <span className="donut-legend-swatch" style={{ background: colorFor(item) }} />
              <span className="donut-legend-label">{item.label}</span>
              <span className="donut-legend-value num">{item.value.toLocaleString('en-IN')}</span>
              <span className="donut-legend-pct num">{total ? `${((item.value / total) * 100).toFixed(0)}%` : '—'}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
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
    { label: 'Total works', value: funnel.total_works.toLocaleString('en-IN'), sub: formatRupees(funnel.total_amount) },
    { label: 'Recommended', value: funnel.recommended.toLocaleString('en-IN'), sub: formatRupees(funnel.recommended_amount) },
    { label: 'Sanctioned', value: funnel.sanctioned.toLocaleString('en-IN'), sub: formatRupees(funnel.sanctioned_amount) },
    { label: 'Completed', value: funnel.completed.toLocaleString('en-IN'), sub: formatRupees(funnel.completed_amount) },
  ] : []

  const severityItems = analytics
    ? ['high', 'medium', 'low'].map((k) => ({ label: SEV_LABEL[k], value: analytics.severity_counts[k] || 0, key: k }))
    : []
  const severityColor = (item) => `var(--sev-${item.key})`
  const tagItems = analytics
    ? Object.entries(analytics.tag_counts).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))
    : []
  const tagColor = (item) => (TAG_COLOR_KEY[item.label] ? `var(--tag-${TAG_COLOR_KEY[item.label]})` : 'var(--ink-faint)')
  const stageItems = analytics
    ? Object.entries(STAGE_LABEL).map(([k, label]) => ({ label, value: analytics.stage_counts[k] || 0 }))
    : []
  const topStateItems = analytics
    ? analytics.top_states.map((s) => ({ label: s.state, value: s.works_flagged, breachRate: s.breach_rate }))
    : []

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
          { label: 'Analytics', onClick: () => scrollToId('mospi-analytics') },
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />

      <div className="mospi-body">
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
          {analytics ? (
            <>
              <DonutCard title="Findings by severity" items={severityItems} colorFor={severityColor} />
              <DonutCard title="Findings by tag" items={tagItems} colorFor={tagColor} />
              <RankChart
                title="Top states by risk"
                items={topStateItems}
                onSelect={(item) => navigate(`/mospi/map?state=${encodeURIComponent(item.label)}`)}
                formatValue={(item) => `${item.value.toLocaleString('en-IN')} flagged`}
              />
              <RankChart title="Works by pipeline stage" items={stageItems} />
            </>
          ) : Array.from({ length: 4 }).map((_, i) => <div className="chart-card" key={i}><Loading label="Loading analytics" /></div>)}
        </div>
      </div>
    </div>
  )
}
