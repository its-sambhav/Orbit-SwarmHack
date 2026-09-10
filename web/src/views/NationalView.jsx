import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, formatRupees, buildSearchIndex } from '../api'
import { MospiNav } from '../components/MospiNav'
import { SeverityChip, TagChip, SEV_LABEL } from '../components/Chips'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

// This page is hardcoded to the current house - MoSPI's live oversight view
// is the sitting Lok Sabha, not a historical comparison, so there is no
// scope toggle here (unlike State/District/MP, which still offer 17th/18th).
const SCOPE = '18th Lok Sabha'

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

export function NationalView() {
  const navigate = useNavigate()
  const [meta, setMeta] = useState(null)
  const [funnel, setFunnel] = useState(null)
  const [analytics, setAnalytics] = useState(null)
  const [constituencies, setConstituencies] = useState(null)
  const [queue, setQueue] = useState(null)
  const [filters, setFilters] = useState({ tag: '', severity: '', state: '', stage: '' })
  const [error, setError] = useState(null)

  useEffect(() => {
    api.meta().then(setMeta).catch((e) => setError(e.message))
    api.funnel(SCOPE).then(setFunnel).catch((e) => setError(e.message))
    api.analytics(SCOPE).then(setAnalytics).catch((e) => setError(e.message))
    api.constituencies(SCOPE).then(setConstituencies).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    setQueue(null)
    api.queue({ scope: SCOPE, ...filters, limit: 60 }).then(setQueue).catch((e) => setError(e.message))
  }, [filters])

  const searchIndex = useMemo(() => buildSearchIndex(constituencies), [constituencies])

  const cards = funnel ? [
    { label: 'Total works', count: funnel.total_works, amount: funnel.total_amount },
    { label: 'Recommended', count: funnel.recommended, amount: funnel.recommended_amount },
    { label: 'Sanctioned', count: funnel.sanctioned, amount: funnel.sanctioned_amount },
    { label: 'Completed', count: funnel.completed, amount: funnel.completed_amount },
  ] : []

  const severityItems = analytics
    ? ['high', 'medium', 'low'].map((k) => ({ label: SEV_LABEL[k], value: analytics.severity_counts[k] || 0, key: k }))
    : []
  const tagItems = analytics
    ? Object.entries(analytics.tag_counts).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))
    : []
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
        scope={SCOPE}
        subtitle={`MoSPI · National Oversight · ${SCOPE}`}
        scopeWorksTotal={funnel?.total_works}
        searchIndex={searchIndex}
        drawerLinks={[
          { label: 'Overview', onClick: () => scrollToId('mospi-overview') },
          { label: 'Map', onClick: () => navigate('/mospi/map') },
          { label: 'Analytics', onClick: () => scrollToId('mospi-analytics') },
          { label: 'Review queue', onClick: () => scrollToId('mospi-queue') },
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
        ]}
      />

      <div className="mospi-body">
        <div className="mospi-stats" id="mospi-overview">
          {cards.length ? cards.map((c) => (
            <div className="mospi-stat-card" key={c.label}>
              <div className="mospi-stat-label">{c.label}</div>
              <div className="mospi-stat-value num">{c.count.toLocaleString('en-IN')}</div>
              <div className="mospi-stat-amount num">{formatRupees(c.amount)}</div>
            </div>
          )) : Array.from({ length: 4 }).map((_, i) => (
            <div className="mospi-stat-card" key={i}><Loading label="" /></div>
          ))}
        </div>

        <button type="button" className="mospi-map-cta" onClick={() => navigate('/mospi/map')}>
          <div>
            <div className="mospi-map-cta-title">Open the India risk map</div>
            <div className="mospi-map-cta-sub">Constituency-level choropleth, {SCOPE}</div>
          </div>
          <span className="mospi-map-cta-arrow">→</span>
        </button>

        <div className="mospi-charts-grid" id="mospi-analytics">
          {analytics ? (
            <>
              <RankChart title="Findings by severity" items={severityItems} colorFor={(item) => `var(--sev-${item.key})`} />
              <RankChart title="Findings by tag" items={tagItems} />
              <RankChart
                title="Top states by risk"
                items={topStateItems}
                onSelect={(item) => navigate(`/state/${encodeURIComponent(item.label)}`)}
                formatValue={(item) => `${item.value.toLocaleString('en-IN')} flagged`}
              />
              <RankChart title="Works by pipeline stage" items={stageItems} />
            </>
          ) : Array.from({ length: 4 }).map((_, i) => <div className="chart-card" key={i}><Loading label="Loading analytics" /></div>)}
        </div>

        <div className="panel">
          <h2>Filters</h2>
          {meta && (
            <div className="filters">
              <select value={filters.tag} onChange={(e) => setFilters({ ...filters, tag: e.target.value })}>
                <option value="">All tags</option>
                {meta.tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={filters.severity} onChange={(e) => setFilters({ ...filters, severity: e.target.value })}>
                <option value="">All severities</option>
                {meta.severities.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={filters.stage} onChange={(e) => setFilters({ ...filters, stage: e.target.value })}>
                <option value="">All stages</option>
                {meta.stages.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="panel" id="mospi-queue">
          <h2>Review queue{queue ? ` — ${queue.total.toLocaleString('en-IN')} works` : ''}</h2>
          {queue ? (
            queue.items.length ? (
              <div className="queue-list queue-grid" style={{ maxHeight: 560 }}>
                {queue.items.map((item) => (
                  <button
                    key={`${item.work_number}-${item.scope_house}-${item.scope_tenure}`}
                    className="queue-item"
                    onClick={() => navigate(`/work/${item.work_number}?scope_house=${encodeURIComponent(item.scope_house)}&scope_tenure=${encodeURIComponent(item.scope_tenure)}`)}
                  >
                    <div className="queue-item-top">
                      <span className="queue-item-title">{item.constituency}, {item.state}</span>
                      <span className="queue-item-amount num">{formatRupees(item.total_exposure)}</span>
                    </div>
                    <div className="queue-item-meta">{item.mp_name} · Work #{item.work_number} · {item.routed_to}</div>
                    <div className="queue-item-chips">
                      <SeverityChip severity={item.max_severity} />
                      {item.tags.map((t) => <TagChip key={t} tag={t} />)}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState title="No findings match these filters" subtitle="Try clearing a filter." />
            )
          ) : (
            <Loading />
          )}
        </div>
      </div>
    </div>
  )
}
