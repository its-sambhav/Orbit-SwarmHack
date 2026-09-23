import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { MospiNav } from '../components/MospiNav'
import { TagChip, StatusChip, RiskChip } from '../components/Chips'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'
import { useLanguage } from '../i18n'

export const MP_DRAWER_LINKS = (navigate) => [
  { label: 'Overview', onClick: () => navigate('/mospi') },
  { label: 'Map', onClick: () => navigate('/mospi/map') },
  { label: 'Anomalies', onClick: () => navigate('/anomalies') },
  { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
]

export function MpAuditsView() {
  const navigate = useNavigate()
  const { t, td } = useLanguage()
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
        subtitle={t('MoSPI · MP Audits')}
        searchIndex={[]}
        drawerLinks={MP_DRAWER_LINKS(navigate)}
      />

      <div className="mospi-body">
        <h1 className="mospi-page-title">{t('drawer.mpAudits')}</h1>
        <p className="mospi-page-sub">
          {t('Every Member of Parliament on record, 17th and 18th Lok Sabha, with their recommendation history and flagged-work rate.')}
        </p>

        <div className="panel">
          <div className="filters">
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">{t('All tenures')}</option>
              <option value="18th Lok Sabha">18th Lok Sabha</option>
              <option value="17th Lok Sabha">17th Lok Sabha</option>
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('Active or former')}</option>
              <option value="Active">{t('Active')}</option>
              <option value="Former">{t('Former')}</option>
            </select>
            <input
              type="search"
              placeholder={t('Search MP, constituency, or state…')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="panel">
          {data ? (
            <>
              <h2>{t(filtered.length === 1 ? '{n} MP' : '{n} MPs', { n: filtered.length.toLocaleString('en-IN') })}</h2>
              {filtered.length ? (
                <div className="queue-list queue-grid" style={{ maxHeight: 680 }}>
                  {filtered.map((m) => (
                    <button
                      key={`${m.mp_name}-${m.scope_tenure}`}
                      className="queue-item"
                      onClick={() => navigate(`/mp-audits/${encodeURIComponent(m.mp_name)}?scope=${encodeURIComponent(m.scope_tenure)}`)}
                    >
                      <div className="queue-item-top">
                        <span className="queue-item-title">{td(m.mp_name)}</span>
                        <RiskChip rate={m.breach_rate} />
                      </div>
                      <div className="queue-item-meta">{td(m.constituency)}, {td(m.state)} · {t(m.scope_tenure)}</div>
                      <div className="queue-item-chips">
                        <StatusChip status={m.status} />
                        <TagChip tag={t('{flagged} / {total} flagged', { flagged: m.works_flagged.toLocaleString('en-IN'), total: m.works_total.toLocaleString('en-IN') })} />
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
