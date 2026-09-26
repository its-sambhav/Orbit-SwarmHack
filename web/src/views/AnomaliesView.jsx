import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, formatRupees } from '../api'
import { useLanguage } from '../i18n'
import { MospiNav } from '../components/MospiNav'
import { ScopeToggle } from '../components/ScopeToggle'
import { SeverityChip, TagChip } from '../components/Chips'
import { TAG_NAMES } from '../tags'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
// the fixed tag vocabulary from config/tags.yaml (mirrored in ../tags.js)
const TAGS = TAG_NAMES
const PAGE_SIZE = 50

export const ANOMALIES_LINK = (navigate) => ({ label: 'Anomalies', onClick: () => navigate('/anomalies') })

// The full, filterable, paginated review queue - MospiMapView and
// StateMapView each already surface a top-N slice of this same /api/queue
// endpoint (sorted by priority) on their own overview, but neither lets a
// reviewer browse past that slice or narrow by severity/tag. This page is
// the complete list those are previews of.
export function AnomaliesView() {
  const navigate = useNavigate()
  const { t, td } = useLanguage()
  // a ?state= param scopes this same queue to one State Nodal Authority's
  // own anomalies (linked from StateView/StateMapView's side menu) instead
  // of MoSPI's all-India queue - read once on mount, same as scope below,
  // since this page owns its own filter state from then on rather than
  // staying synced to the URL.
  const [searchParams] = useSearchParams()
  const stateFilter = searchParams.get('state') || ''
  const [scope, setScope] = useState(searchParams.get('scope') || 'all')
  // ...and a dashboard's High-severity card with ?severity=high
  const [severity, setSeverity] = useState(searchParams.get('severity') || '')
  // a dashboard's "Findings by tag" chart links here with ?tag=<engine tag>
  const [tag, setTag] = useState(searchParams.get('tag') || '')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  // this queue is the real, unpaginated-anywhere-else dataset (hundreds of
  // thousands of works), so search runs server-side via /api/queue's own
  // `q` param rather than filtering whatever page happens to be loaded -
  // debounced so it doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  // any filter change restarts at the first page - a stale offset from a
  // previous, larger result set could otherwise land past the end of a
  // newly-narrowed one.
  useEffect(() => { setOffset(0) }, [scope, severity, tag, debouncedSearch])

  useEffect(() => {
    setData(null)
    api.queue({
      scope, q: debouncedSearch || undefined, severity: severity || undefined, tag: tag || undefined,
      state: stateFilter || undefined, limit: PAGE_SIZE, offset,
    }).then(setData).catch((e) => setError(e.message))
  }, [scope, severity, tag, debouncedSearch, offset, stateFilter])

  if (error) return <ErrorView message={error} onRetry={() => window.location.reload()} />

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={stateFilter
          ? t('State Nodal Authority · {state} · Anomalies', { state: td(stateFilter) })
          : t('MoSPI · Anomalies')}
        searchIndex={[]}
        showSearch={!stateFilter}
        profileName={stateFilter || undefined}
        profileRole={stateFilter ? 'State Nodal Authority' : undefined}
        avatarLetter={stateFilter ? 'S' : undefined}
        drawerLinks={stateFilter ? [
          { label: 'Overview', onClick: () => navigate(`/state/${encodeURIComponent(stateFilter)}`) },
          { label: 'Map', onClick: () => navigate(`/state/${encodeURIComponent(stateFilter)}/map`) },
          { label: 'Anomalies', onClick: () => navigate(`/anomalies?state=${encodeURIComponent(stateFilter)}`) },
        ] : [
          { label: 'Overview', onClick: () => navigate('/mospi') },
          { label: 'Map', onClick: () => navigate('/mospi/map') },
          ANOMALIES_LINK(navigate),
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />

      <div className="mospi-body">
        <h1 className="mospi-page-title">{stateFilter ? `${t('drawer.anomalies')} — ${td(stateFilter)}` : t('drawer.anomalies')}</h1>
        <p className="mospi-page-sub">
          {stateFilter
            ? t("Every flagged work in {state}, ranked by priority - the full review queue this state's own Overview and Map pages each surface only a slice of.", { state: td(stateFilter) })
            : t('Every flagged work across India, ranked by priority - the full review queue the Overview and Map pages each surface only a slice of.')}
        </p>

        <div className="panel">
          <div className="filters">
            <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
            <input
              type="search" placeholder={t('Search works…')} aria-label={t('Search works')}
              value={search} onChange={(e) => setSearch(e.target.value)}
            />
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">{t('All severities')}</option>
              <option value="high">{t('High')}</option>
              <option value="medium">{t('Medium')}</option>
              <option value="low">{t('Low')}</option>
            </select>
            <select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">{t('All tags')}</option>
              {/* value stays the engine's English tag (what /api/queue filters on);
                  only the visible option text is translated */}
              {TAGS.map((tag) => <option key={tag} value={tag}>{t(tag)}</option>)}
            </select>
          </div>
        </div>

        <div className="panel">
          {data ? (
            <>
              <h2>{t(data.total === 1 ? '{n} anomaly' : '{n} anomalies', { n: data.total.toLocaleString('en-IN') })}</h2>
              {data.items.length ? (
                <div className="queue-list queue-grid">
                  {data.items.map((item) => (
                    <button
                      key={`${item.work_number}-${item.scope_house}-${item.scope_tenure}`}
                      className="queue-item"
                      onClick={() => navigate(`/work/${item.work_number}?scope_house=${encodeURIComponent(item.scope_house)}&scope_tenure=${encodeURIComponent(item.scope_tenure)}`)}
                    >
                      <div className="queue-item-top">
                        <span className="queue-item-title">
                          {item.constituency
                            ? `${td(item.constituency)}, ${td(item.state ?? '')}`
                            : t('Work #{n}', { n: item.work_number })}
                        </span>
                        <span className="queue-item-amount num">{formatRupees(item.total_exposure)}</span>
                      </div>
                      {item.work_description && <p className="queue-item-desc">{td(item.work_description)}</p>}
                      <div className="queue-item-meta">
                        {[item.mp_name && td(item.mp_name), t('Work #{n}', { n: item.work_number }), item.routed_to && t(item.routed_to)].filter(Boolean).join(' · ')}
                      </div>
                      <div className="queue-item-chips">
                        <SeverityChip severity={item.max_severity} />
                        {item.tags.map((tag) => <TagChip key={tag} tag={tag} />)}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState title="No anomalies match these filters" subtitle="Try clearing a filter." />
              )}

              {totalPages > 1 && (
                <div className="pager">
                  <button
                    type="button" className="action-btn" disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    {t('Previous')}
                  </button>
                  <span className="pager-label">
                    {t('Page {current} of {total}', {
                      current: currentPage.toLocaleString('en-IN'), total: totalPages.toLocaleString('en-IN'),
                    })}
                  </span>
                  <button
                    type="button" className="action-btn" disabled={offset + PAGE_SIZE >= data.total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    {t('Next')}
                  </button>
                </div>
              )}
            </>
          ) : (
            <Loading label="Loading anomalies" />
          )}
        </div>
      </div>
    </div>
  )
}
