import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { MospiNav } from '../components/MospiNav'
import { TagChip, StatusChip, RiskChip } from '../components/Chips'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

export const MP_DRAWER_LINKS = (navigate) => [
  { label: 'Overview', onClick: () => navigate('/mospi') },
  { label: 'Map', onClick: () => navigate('/mospi/map') },
  { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
]

export function MpAuditsView() {
  const navigate = useNavigate()
  const [scope, setScope] = useState('all')
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setData(null)
    api.mps({ scope, status: status || undefined }).then(setData).catch((e) => setError(e.message))
  }, [scope, status])

  // free-text search is filtered client-side against the already-fetched
  // scope+status slice (at most ~1,100 rows) rather than a request per
  // keystroke - the whole directory is a small enough payload that this is
  // both simpler and more responsive than debouncing a server round-trip.
  const filtered = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    if (!q) return data.items
    return data.items.filter((m) =>
      m.mp_name.toLowerCase().includes(q)
      || (m.constituency || '').toLowerCase().includes(q)
      || (m.state || '').toLowerCase().includes(q)
    )
  }, [data, query])

  if (error) return <ErrorView message={error} onRetry={() => window.location.reload()} />

  return (
    <div className="mospi-page">
      <MospiNav
        scope="18th Lok Sabha"
        subtitle="MoSPI · MP Audits"
        searchIndex={[]}
        drawerLinks={MP_DRAWER_LINKS(navigate)}
      />

      <div className="mospi-body">
        <h1 className="mospi-page-title">MP Audits</h1>
        <p className="mospi-page-sub">
          Every Member of Parliament on record, 17th and 18th Lok Sabha, with their recommendation history and flagged-work rate.
        </p>

        <div className="panel">
          <div className="filters">
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">All tenures</option>
              <option value="18th Lok Sabha">18th Lok Sabha</option>
              <option value="17th Lok Sabha">17th Lok Sabha</option>
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Active or former</option>
              <option value="Active">Active</option>
              <option value="Former">Former</option>
            </select>
            <input
              type="search"
              placeholder="Search MP, constituency, or state…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="panel">
          {data ? (
            <>
              <h2>{filtered.length.toLocaleString('en-IN')} MP{filtered.length === 1 ? '' : 's'}</h2>
              {filtered.length ? (
                <div className="queue-list queue-grid" style={{ maxHeight: 680 }}>
                  {filtered.map((m) => (
                    <button
                      key={`${m.mp_name}-${m.scope_tenure}`}
                      className="queue-item"
                      onClick={() => navigate(`/mp-audits/${encodeURIComponent(m.mp_name)}?scope=${encodeURIComponent(m.scope_tenure)}`)}
                    >
                      <div className="queue-item-top">
                        <span className="queue-item-title">{m.mp_name}</span>
                        <RiskChip rate={m.breach_rate} />
                      </div>
                      <div className="queue-item-meta">{m.constituency}, {m.state} · {m.scope_tenure}</div>
                      <div className="queue-item-chips">
                        <StatusChip status={m.status} />
                        <TagChip tag={`${m.works_flagged.toLocaleString('en-IN')} / ${m.works_total.toLocaleString('en-IN')} flagged`} />
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState title="No MPs match these filters" subtitle="Try clearing a filter or search term." />
              )}
            </>
          ) : (
            <Loading label="Loading MP directory" />
          )}
        </div>
      </div>
    </div>
  )
}
