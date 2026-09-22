import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, formatRupees } from '../api'
import { MospiNav } from '../components/MospiNav'
import { ScopeToggle } from '../components/ScopeToggle'
import { SeverityChip, TagChip } from '../components/Chips'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
// the fixed, canonical tag vocabulary (config/detectors.yaml's 8 distinct
// tag values across all 13 detectors) - hardcoded the same way SCOPES above
// and every other filter dropdown in this app already is, since detectors
// are a build-time config, not data to fetch.
const TAGS = [
  'GHOST ASSET', 'TIME DELAY', 'COST OUTLIER', 'DUPLICATION',
  'STATUTORY COMPLIANCE', 'OVER ALLOCATION', 'AGENCY CONCENTRATION', 'DATA INTEGRITY',
]
const PAGE_SIZE = 50

export const ANOMALIES_LINK = (navigate) => ({ label: 'Anomalies', onClick: () => navigate('/anomalies') })

// The full, filterable, paginated review queue - MospiMapView and
// StateMapView each already surface a top-N slice of this same /api/queue
// endpoint (sorted by priority) on their own overview, but neither lets a
// reviewer browse past that slice or narrow by severity/tag. This page is
// the complete list those are previews of.
export function AnomaliesView() {
  const navigate = useNavigate()
  const [scope, setScope] = useState('all')
  const [severity, setSeverity] = useState('')
  const [tag, setTag] = useState('')
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
    api.queue({ scope, q: debouncedSearch || undefined, severity: severity || undefined, tag: tag || undefined, limit: PAGE_SIZE, offset })
      .then(setData).catch((e) => setError(e.message))
  }, [scope, severity, tag, debouncedSearch, offset])

  if (error) return <ErrorView message={error} onRetry={() => window.location.reload()} />

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle="MoSPI · Anomalies"
        searchIndex={[]}
        drawerLinks={[
          { label: 'Overview', onClick: () => navigate('/mospi') },
          { label: 'Map', onClick: () => navigate('/mospi/map') },
          ANOMALIES_LINK(navigate),
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />

      <div className="mospi-body">
        <h1 className="mospi-page-title">Anomalies</h1>
        <p className="mospi-page-sub">
          Every flagged work across India, ranked by priority - the full review queue the Overview and
          Map pages each surface only a slice of.
        </p>

        <div className="panel">
          <div className="filters">
            <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
            <input
              type="search" placeholder="Search works…" aria-label="Search works"
              value={search} onChange={(e) => setSearch(e.target.value)}
            />
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">All severities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">All tags</option>
              {TAGS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div className="panel">
          {data ? (
            <>
              <h2>{data.total.toLocaleString('en-IN')} anomal{data.total === 1 ? 'y' : 'ies'}</h2>
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
                          {item.constituency ? `${item.constituency}, ${item.state ?? ''}` : `Work #${item.work_number}`}
                        </span>
                        <span className="queue-item-amount num">{formatRupees(item.total_exposure)}</span>
                      </div>
                      {item.work_description && <p className="queue-item-desc">{item.work_description}</p>}
                      <div className="queue-item-meta">
                        {[item.mp_name, `Work #${item.work_number}`, item.routed_to].filter(Boolean).join(' · ')}
                      </div>
                      <div className="queue-item-chips">
                        <SeverityChip severity={item.max_severity} />
                        {item.tags.map((t) => <TagChip key={t} tag={t} />)}
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
                    Previous
                  </button>
                  <span className="pager-label">Page {currentPage.toLocaleString('en-IN')} of {totalPages.toLocaleString('en-IN')}</span>
                  <button
                    type="button" className="action-btn" disabled={offset + PAGE_SIZE >= data.total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next
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
