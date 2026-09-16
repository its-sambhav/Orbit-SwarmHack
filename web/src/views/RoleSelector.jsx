import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, setAuthToken } from '../api'
import { Loading } from '../components/StateViews'

// matches the scope every dashboard defaults to on entry - the picker's
// stats should match what you'll actually see next, not a different scope.
const DEFAULT_SCOPE = '18th Lok Sabha'

const ROLES = [
  { id: 'mospi', label: 'MoSPI', description: 'National oversight — every state, every scope.' },
  { id: 'state', label: 'State Nodal Authority', description: 'One state — its districts and MPs.' },
  { id: 'district', label: 'District Authority', description: 'One district — sanction and execution monitoring.' },
  { id: 'agency', label: 'Implementing Agency', description: 'Only the works assigned to your agency.' },
  { id: 'mp', label: 'Member of Parliament', description: 'One constituency — your own recommended works.' },
]
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.id, r.label]))

export function RoleSelector() {
  const navigate = useNavigate()
  const [role, setRole] = useState(null)
  const [states, setStates] = useState(null)
  const [districts, setDistricts] = useState(null)
  const [mps, setMps] = useState(null)
  const [agencyQuery, setAgencyQuery] = useState('')
  const [agencies, setAgencies] = useState(null)
  const [selectedState, setSelectedState] = useState('')
  // the role/entity/destination waiting on a password before it navigates -
  // { role, entity, label, navigateTo } or null
  const [pendingAuth, setPendingAuth] = useState(null)
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState(null)
  const [authLoading, setAuthLoading] = useState(false)

  useEffect(() => {
    if (role === 'state' || role === 'district') {
      api.states({ scope: DEFAULT_SCOPE }).then((d) => setStates(d.items))
    }
    // by MP name, not constituency - one constituency can have a different
    // MP across tenures, and /api/mp/{name} is name-keyed like MP Audits.
    if (role === 'mp') {
      api.mps({ scope: DEFAULT_SCOPE }).then((d) => setMps(d.items))
    }
  }, [role])

  // agencies have no geographic parent to cascade through and there are
  // thousands of them, so unlike the other 3 roles this always searches
  // rather than eager-fetching a full list.
  useEffect(() => {
    if (role !== 'agency') return
    const handle = setTimeout(() => {
      api.agencies({ scope: DEFAULT_SCOPE, q: agencyQuery, limit: 25 }).then((d) => setAgencies(d.items))
    }, 300)
    return () => clearTimeout(handle)
  }, [role, agencyQuery])

  useEffect(() => {
    if (role === 'district' && selectedState) {
      setDistricts(null)
      api.districts(selectedState, DEFAULT_SCOPE).then((d) => setDistricts(d.items))
    }
  }, [role, selectedState])

  // every "go" below used to navigate straight there; now each one just
  // queues the password step for that exact role+entity, and navigation
  // only happens once /api/auth/login actually issues a token for it.
  const goMospi = () => { setPendingAuth({ role: 'mospi', entity: null, label: 'MoSPI', navigateTo: '/mospi' }); setPassword(''); setAuthError(null) }
  const goState = (state) => { setPendingAuth({ role: 'state', entity: state, label: state, navigateTo: `/state/${encodeURIComponent(state)}` }); setPassword(''); setAuthError(null) }
  const goDistrict = (state, district) => { setPendingAuth({ role: 'district', entity: `${state}|${district}`, label: `${district}, ${state}`, navigateTo: `/district-authority/${encodeURIComponent(state)}/${encodeURIComponent(district)}` }); setPassword(''); setAuthError(null) }
  const goMp = (mpName, scopeTenure) => { setPendingAuth({ role: 'mp', entity: mpName, label: mpName, navigateTo: `/mp/${encodeURIComponent(mpName)}?scope=${encodeURIComponent(scopeTenure)}` }); setPassword(''); setAuthError(null) }
  const goAgency = (agency) => { setPendingAuth({ role: 'agency', entity: agency, label: agency, navigateTo: `/agency/${encodeURIComponent(agency)}` }); setPassword(''); setAuthError(null) }

  async function submitLogin() {
    setAuthError(null)
    if (!password) { setAuthError('Enter the password.'); return }
    setAuthLoading(true)
    try {
      const res = await api.login(pendingAuth.role, password, pendingAuth.entity)
      setAuthToken(res.token, res.role, res.entity)
      navigate(pendingAuth.navigateTo)
    } catch (e) {
      setAuthError(e.message)
    } finally {
      setAuthLoading(false)
    }
  }

  return (
    <div className="role-selector">
      <div className="role-selector-inner">
        <h1>MPLADS Review</h1>
        <p className="role-selector-sub">
          Unsupervised prioritisation, not a verdict — every finding here is a flag for human
          review, routed to whichever authority owns that stage of the work's lifecycle.
        </p>

        {pendingAuth ? (
          <>
            <button className="btn-link" onClick={() => { setPendingAuth(null); setAuthError(null) }}>← back</button>
            <h2>Sign in as {ROLE_LABEL[pendingAuth.role]}{pendingAuth.entity ? ` · ${pendingAuth.label}` : ''}</h2>
            <input
              type="password"
              className="picker-search"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitLogin() }}
              autoFocus
            />
            {authError && <p className="status-form-error">{authError}</p>}
            <button type="button" className="action-btn" disabled={authLoading} onClick={submitLogin}>
              {authLoading ? 'Signing in…' : 'Sign in'}
            </button>
          </>
        ) : (
        <>
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
              This is a prototype — each role has one shared demo password (not real per-person
              credentials), but signing in issues a real token the backend checks on every
              request: it will reject a request for a jurisdiction that token isn't scoped to.
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
            <h2>Which MP (18th Lok Sabha)?</h2>
            {!mps ? <Loading /> : (
              <div className="picker-list">
                {mps.map((m) => (
                  <button key={`${m.mp_name}-${m.scope_tenure}`} className="picker-item" onClick={() => goMp(m.mp_name, m.scope_tenure)}>
                    <span>{m.mp_name}</span>
                    <span className="picker-item-meta">{m.constituency}, {m.state}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {role === 'agency' && (
          <>
            <button className="btn-link" onClick={() => { setRole(null); setAgencyQuery(''); setAgencies(null) }}>← back</button>
            <h2>Which implementing agency?</h2>
            <input
              type="search"
              className="picker-search"
              placeholder="Search agency name…"
              value={agencyQuery}
              onChange={(e) => setAgencyQuery(e.target.value)}
              autoFocus
            />
            {agencies === null ? (
              agencyQuery ? <Loading /> : <p className="panel-note">Start typing an agency name - there are thousands, so this always searches rather than listing them all.</p>
            ) : (
              <div className="picker-list">
                {agencies.map((a) => (
                  <button key={a.agency} className="picker-item" onClick={() => goAgency(a.agency)}>
                    <span>{a.agency}</span>
                    <span className="picker-item-meta">{a.works_total.toLocaleString('en-IN')} works · {(a.breach_rate * 100).toFixed(0)}% breach rate</span>
                  </button>
                ))}
                {agencies.length === 0 && <p className="panel-note">No agency name matches "{agencyQuery}".</p>}
              </div>
            )}
          </>
        )}
        </>
        )}
      </div>
    </div>
  )
}
