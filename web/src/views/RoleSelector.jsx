import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Loading } from '../components/StateViews'

// matches the scope every dashboard defaults to on entry - the picker's
// stats should match what you'll actually see next, not a different scope.
const DEFAULT_SCOPE = '18th Lok Sabha'

const ROLES = [
  { id: 'mospi', label: 'MoSPI', description: 'National oversight — every state, every scope.' },
  { id: 'state', label: 'State Nodal Authority', description: 'One state — its districts and MPs.' },
  { id: 'district', label: 'District Authority', description: 'One district — sanction and execution monitoring.' },
  { id: 'mp', label: 'Member of Parliament', description: 'One constituency — your own recommended works.' },
]

export function RoleSelector() {
  const navigate = useNavigate()
  const [role, setRole] = useState(null)
  const [states, setStates] = useState(null)
  const [districts, setDistricts] = useState(null)
  const [constituencies, setConstituencies] = useState(null)
  const [selectedState, setSelectedState] = useState('')

  useEffect(() => {
    if (role === 'state' || role === 'district') {
      api.states({ scope: DEFAULT_SCOPE }).then((d) => setStates(d.items))
    }
    if (role === 'mp') {
      api.constituencies('18th Lok Sabha').then((d) => setConstituencies(d.items))
    }
  }, [role])

  useEffect(() => {
    if (role === 'district' && selectedState) {
      setDistricts(null)
      api.districts(selectedState, DEFAULT_SCOPE).then((d) => setDistricts(d.items))
    }
  }, [role, selectedState])

  const goMospi = () => navigate('/mospi')
  const goState = (state) => navigate(`/state/${encodeURIComponent(state)}`)
  const goDistrict = (state, district) => navigate(`/district/${encodeURIComponent(state)}/${encodeURIComponent(district)}`)
  const goMp = (constituencyId) => navigate(`/mp/${constituencyId}`)

  return (
    <div className="role-selector">
      <div className="role-selector-inner">
        <h1>MPLADS Review</h1>
        <p className="role-selector-sub">
          Unsupervised prioritisation, not a verdict — every finding here is a flag for human
          review, routed to whichever authority owns that stage of the work's lifecycle.
        </p>

        {!role && (
          <>
            <h2>Who's viewing?</h2>
            <div className="role-grid">
              {ROLES.map((r) => (
                <button key={r.id} className="role-card" onClick={() => (r.id === 'mospi' ? goMospi() : setRole(r.id))}>
                  <div className="role-card-label">{r.label}</div>
                  <div className="role-card-desc">{r.description}</div>
                </button>
              ))}
            </div>
            <p className="role-selector-note">
              This is a prototype — picking a role scopes the dashboard to that jurisdiction's
              data, it isn't a login. A real deployment would authenticate this the same way
              eSAKSHI itself does.
            </p>
          </>
        )}

        {role === 'state' && (
          <>
            <button className="btn-link" onClick={() => setRole(null)}>← back</button>
            <h2>Which state?</h2>
            {!states ? <Loading /> : (
              <div className="picker-list">
                {states.map((s) => (
                  <button key={s.state} className="picker-item" onClick={() => goState(s.state)}>
                    <span>{s.state}</span>
                    <span className="picker-item-meta">{s.districts} districts · {(s.breach_rate * 100).toFixed(0)}% breach rate</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {role === 'district' && (
          <>
            <button className="btn-link" onClick={() => { setRole(null); setSelectedState(''); setDistricts(null) }}>← back</button>
            {!selectedState ? (
              <>
                <h2>Which state?</h2>
                {!states ? <Loading /> : (
                  <div className="picker-list">
                    {states.map((s) => (
                      <button key={s.state} className="picker-item" onClick={() => setSelectedState(s.state)}>
                        <span>{s.state}</span>
                        <span className="picker-item-meta">{s.districts} districts</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <h2>Which district in {selectedState}?</h2>
                {!districts ? <Loading /> : (
                  <div className="picker-list">
                    {districts.map((d) => (
                      <button key={d.district} className="picker-item" onClick={() => goDistrict(selectedState, d.district)}>
                        <span>{d.district}</span>
                        <span className="picker-item-meta">{d.works_total.toLocaleString('en-IN')} works · {(d.breach_rate * 100).toFixed(0)}% breach rate</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {role === 'mp' && (
          <>
            <button className="btn-link" onClick={() => setRole(null)}>← back</button>
            <h2>Which constituency (18th Lok Sabha)?</h2>
            {!constituencies ? <Loading /> : (
              <div className="picker-list">
                {constituencies.map((c) => (
                  <button key={c.constituency_id} className="picker-item" onClick={() => goMp(c.constituency_id)}>
                    <span>{c.constituency}</span>
                    <span className="picker-item-meta">{c.state} · {(c.breach_rate * 100).toFixed(0)}% breach rate</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
