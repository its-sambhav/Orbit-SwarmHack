import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, formatRupees } from '../api'
import { Funnel } from '../components/Funnel'
import { SeverityChip, TagChip } from '../components/Chips'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

export function StateView() {
  const { stateName } = useParams()
  const navigate = useNavigate()
  const [scope, setScope] = useState('18th Lok Sabha')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setData(null)
    api.state(stateName, scope).then(setData).catch((e) => setError(e.message))
  }, [stateName, scope])

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading state" />

  return (
    <div className="role-dashboard">
      <div className="role-dashboard-header">
        <div>
          <Link className="back-link" to="/">← Switch role</Link>
          <h1>{data.state}</h1>
          <div className="meta">State Nodal Authority · {data.districts.length} districts</div>
        </div>
        <select className="scope-select" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="18th Lok Sabha">18th Lok Sabha</option>
          <option value="17th Lok Sabha">17th Lok Sabha</option>
        </select>
      </div>

      <div className="role-dashboard-stats">
        <div className="stat-tile"><div className="stat-tile-label">Works</div><div className="stat-tile-value num">{data.works_total.toLocaleString('en-IN')}</div></div>
        <div className="stat-tile"><div className="stat-tile-label">Flagged</div><div className="stat-tile-value num">{data.works_flagged.toLocaleString('en-IN')}</div></div>
        <div className="stat-tile"><div className="stat-tile-label">Breach rate</div><div className="stat-tile-value num">{(data.breach_rate * 100).toFixed(1)}%</div></div>
        <div className="stat-tile"><div className="stat-tile-label">Exposure</div><div className="stat-tile-value num">{formatRupees(data.total_exposure)}</div></div>
      </div>

      <div className="role-dashboard-grid">
        <div className="panel">
          <h2>Funnel — {scope}</h2>
          <Funnel funnel={{ ...data.funnel, never_sanctioned: data.funnel.recommended - data.funnel.sanctioned, sanctioned_never_completed: data.funnel.sanctioned - data.funnel.completed }} />
        </div>

        <div className="panel">
          <h2>Districts ({data.districts.length})</h2>
          <div className="rank-list">
            {data.districts.map((d) => (
              <button key={d.district} className="rank-item" onClick={() => navigate(`/district/${encodeURIComponent(data.state)}/${encodeURIComponent(d.district)}`)}>
                <span className="rank-item-name">{d.district}</span>
                <span className="rank-item-meta">{d.works_flagged.toLocaleString('en-IN')} / {d.works_total.toLocaleString('en-IN')} flagged</span>
                <span className="rank-item-bar"><span style={{ width: `${d.breach_rate * 100}%` }} /></span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Highest-priority works ({data.queue.length} shown)</h2>
        {data.queue.length ? (
          <div className="queue-list">
            {data.queue.map((item) => (
              <button
                key={`${item.work_number}-${item.scope_house}-${item.scope_tenure}`}
                className="queue-item"
                onClick={() => navigate(`/work/${item.work_number}?scope_house=${encodeURIComponent(item.scope_house)}&scope_tenure=${encodeURIComponent(item.scope_tenure)}`)}
              >
                <div className="queue-item-top">
                  <span className="queue-item-title">{item.district} — {item.constituency}</span>
                  <span className="queue-item-amount num">{formatRupees(item.total_exposure)}</span>
                </div>
                <div className="queue-item-meta">{item.mp_name} · Work #{item.work_number}</div>
                <div className="queue-item-chips">
                  <SeverityChip severity={item.max_severity} />
                  {item.tags.map((t) => <TagChip key={t} tag={t} />)}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState title="No findings above the queue threshold" subtitle="This state has no work currently past its review floor for this scope." />
        )}
      </div>
    </div>
  )
}
