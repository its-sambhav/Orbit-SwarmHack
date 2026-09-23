import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, setAuthToken } from '../api'
import { Loading } from '../components/StateViews'
import { useLanguage } from '../i18n'

// matches the scope every dashboard defaults to on entry - the picker's
// stats should match what you'll actually see next, not a different scope.
const DEFAULT_SCOPE = '18th Lok Sabha'

// auth is one shared password per ROLE (api/auth.py), not per-person
// accounts - so the login "username" is the role's id. The passwords are the
// demo ones from config/auth.yaml (plaintext there on purpose, see that
// file's header) - keep the two in sync; they feed the credentials table.
const ROLES = [
  { id: 'mospi', label: 'MoSPI', password: 'mospi-2026' },
  { id: 'state', label: 'State Nodal Authority', password: 'state-2026' },
  { id: 'district', label: 'District Authority', password: 'district-2026' },
  { id: 'agency', label: 'Implementing Agency', password: 'agency-2026' },
  { id: 'mp', label: 'Member of Parliament', password: 'mp-2026' },
]
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.id, r.label]))

// same wording for an unknown username and a wrong password, so the form
// doesn't say which of the two was off.
const BAD_CREDENTIALS = 'Incorrect username or password.'

const iconProps = {
  width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}
const UserIcon = () => (
  <svg {...iconProps}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></svg>
)
const LockIcon = () => (
  <svg {...iconProps}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
)
const InfoIcon = () => (
  <svg {...iconProps} width={18} height={18}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
)
const ChevronIcon = () => (
  <svg {...iconProps} className="login-chevron"><path d="M6 9l6 6 6-6" /></svg>
)
const EyeIcon = ({ off }) => (
  <svg {...iconProps}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
    {off && <path d="M4 4l16 16" />}
  </svg>
)

export function RoleSelector() {
  const navigate = useNavigate()
  const { t, td } = useLanguage()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  // the demo-credentials table under the button starts collapsed
  const [showCreds, setShowCreds] = useState(false)
  // set once the username + password check out for a role that still has to
  // pick its own state/district/MP/agency - null while on the login form
  const [role, setRole] = useState(null)
  const [states, setStates] = useState(null)
  const [districts, setDistricts] = useState(null)
  const [mps, setMps] = useState(null)
  const [agencyQuery, setAgencyQuery] = useState('')
  const [agencies, setAgencies] = useState(null)
  const [selectedState, setSelectedState] = useState('')
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

  async function submitLogin(e) {
    e.preventDefault()
    setAuthError(null)
    const id = username.trim().toLowerCase()
    if (!id || !password) { setAuthError(t('Enter your username and password.')); return }
    if (!ROLE_LABEL[id]) { setAuthError(t(BAD_CREDENTIALS)); return }
    setAuthLoading(true)
    try {
      // only mospi needs no entity, so it's the only role this succeeds for
      const res = await api.login(id, password, null)
      setAuthToken(res.token, res.role, res.entity)
      navigate('/mospi')
    } catch (err) {
      // /api/auth/login checks the password before it checks for an entity,
      // so a 400 means the password was right and this role still has to
      // pick which state/district/MP/agency it is signing in as.
      if (err.status === 400) setRole(id)
      else setAuthError(err.status === 401 ? t(BAD_CREDENTIALS) : err.message)
    } finally {
      setAuthLoading(false)
    }
  }

  // the token is scoped to exactly one entity, so it is only issued now,
  // with the password held from the login form.
  async function signInAs(entity, navigateTo) {
    setAuthError(null)
    setAuthLoading(true)
    try {
      const res = await api.login(role, password, entity)
      setAuthToken(res.token, res.role, res.entity)
      navigate(navigateTo)
    } catch (err) {
      setAuthError(err.message)
    } finally {
      setAuthLoading(false)
    }
  }
  const goState = (state) => signInAs(state, `/state/${encodeURIComponent(state)}`)
  const goDistrict = (state, district) => signInAs(`${state}|${district}`, `/district-authority/${encodeURIComponent(state)}/${encodeURIComponent(district)}`)
  const goMp = (mpName, scopeTenure) => signInAs(mpName, `/mp/${encodeURIComponent(mpName)}?scope=${encodeURIComponent(scopeTenure)}`)
  const goAgency = (agency) => signInAs(agency, `/agency/${encodeURIComponent(agency)}`)

  function backToLogin() {
    setRole(null)
    setPassword('')
    setShowPassword(false)
    setAuthError(null)
    setSelectedState('')
    setDistricts(null)
    setAgencyQuery('')
    setAgencies(null)
  }

  return (
    <div className="login-page">
      <div className="login-hero">
        <img src="/parliament.jpg" alt="" />
        <div className="login-hero-caption">
          <span className="login-hero-rule" aria-hidden="true" />
          <div className="login-hero-title">MPLADS Review</div>
          <div className="login-hero-sub">{t('Anomaly review & oversight dashboard')}</div>
        </div>
      </div>

      <main className="login-panel">
        <div className="login-panel-inner">
          <div className="login-brand">
            <img className="login-brand-emblem" src="/emblem.svg" alt={t('Government of India')} />
            <div className="login-brand-text">
              <div className="login-brand-gov">{t('Government of India')}</div>
              <div className="login-brand-ministry">{t('Ministry of Statistics and Programme Implementation')}</div>
              <div className="login-brand-scheme">{t('Members of Parliament Local Area Development Scheme')}</div>
            </div>
          </div>

          {!role ? (
            <>
            <form onSubmit={submitLogin} noValidate>
              <h1 className="login-title">{t('Log In')}</h1>

              <div className="login-field">
                <UserIcon />
                <input
                  type="text" name="username" placeholder={t('Username')} aria-label={t('Username')}
                  autoComplete="username" autoCapitalize="none" spellCheck={false}
                  value={username} onChange={(e) => setUsername(e.target.value)} autoFocus
                />
              </div>

              <div className="login-field">
                <LockIcon />
                <input
                  type={showPassword ? 'text' : 'password'} name="password" placeholder={t('Password')} aria-label={t('Password')}
                  autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button" className="login-eye" aria-pressed={showPassword}
                  aria-label={t(showPassword ? 'Hide password' : 'Show password')}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  <EyeIcon off={showPassword} />
                </button>
              </div>

              {authError && <p className="login-error" role="alert">{authError}</p>}
              <button type="submit" className="login-submit" disabled={authLoading}>
                {authLoading ? t('Signing in…') : t('Login')}
              </button>

            </form>

            <section className="login-creds">
              <button
                type="button" className="login-creds-toggle" aria-expanded={showCreds} aria-controls="login-creds-table"
                onClick={() => setShowCreds((v) => !v)}
              >
                {t('Demo credentials')}
                <span className="login-creds-state">{t(showCreds ? 'Hide' : 'Show')}</span>
                <ChevronIcon />
              </button>
              <div className="login-creds-wrap" id="login-creds-table" hidden={!showCreds}>
                <table className="login-creds-table">
                  <thead>
                    <tr><th scope="col">{t('Dashboard')}</th><th scope="col">{t('Username')}</th><th scope="col">{t('Password')}</th></tr>
                  </thead>
                  <tbody>
                    {ROLES.map((r) => (
                      <tr key={r.id}>
                        <th scope="row">{t(r.label)}</th>
                        <td><code>{r.id}</code></td>
                        <td><code>{r.password}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <aside className="login-callout">
              <InfoIcon />
              <p><strong>{t('Unsupervised prioritisation, not a verdict.')}</strong> {t('Every finding here is a flag for human review.')}</p>
            </aside>
            </>
          ) : (
            <>
              <button type="button" className="btn-link" onClick={backToLogin}>{t('← back')}</button>
              <p className="login-picker-role">{t('Signing in as')} <strong>{t(ROLE_LABEL[role])}</strong></p>
              {authError && <p className="login-error" role="alert">{authError}</p>}

              {role === 'state' && (
                <>
                  <h2>{t('Which state?')}</h2>
                  {!states ? <Loading /> : (
                    <div className="picker-list">
                      {states.map((s) => (
                        <button key={s.state} className="picker-item" disabled={authLoading} onClick={() => goState(s.state)}>
                          <span>{td(s.state)}</span>
                          <span className="picker-item-meta">{t('{n} districts · {rate}% breach rate', { n: s.districts, rate: (s.breach_rate * 100).toFixed(0) })}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {role === 'district' && (!selectedState ? (
                <>
                  <h2>{t('Which state?')}</h2>
                  {!states ? <Loading /> : (
                    <div className="picker-list">
                      {states.map((s) => (
                        <button key={s.state} className="picker-item" onClick={() => setSelectedState(s.state)}>
                          <span>{td(s.state)}</span>
                          <span className="picker-item-meta">{t('{n} districts', { n: s.districts })}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <h2>{t('Which district in {state}?', { state: td(selectedState) })}</h2>
                  {!districts ? <Loading /> : (
                    <div className="picker-list">
                      {districts.map((d) => (
                        <button key={d.district} className="picker-item" disabled={authLoading} onClick={() => goDistrict(selectedState, d.district)}>
                          <span>{td(d.district)}</span>
                          <span className="picker-item-meta">{t('{n} works · {rate}% breach rate', { n: d.works_total.toLocaleString('en-IN'), rate: (d.breach_rate * 100).toFixed(0) })}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ))}

              {role === 'mp' && (
                <>
                  <h2>{t('Which MP (18th Lok Sabha)?')}</h2>
                  {!mps ? <Loading /> : (
                    <div className="picker-list">
                      {mps.map((m) => (
                        <button key={`${m.mp_name}-${m.scope_tenure}`} className="picker-item" disabled={authLoading} onClick={() => goMp(m.mp_name, m.scope_tenure)}>
                          <span>{td(m.mp_name)}</span>
                          <span className="picker-item-meta">{td(m.constituency)}, {td(m.state)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {role === 'agency' && (
                <>
                  <h2>{t('Which implementing agency?')}</h2>
                  <input
                    type="search"
                    className="picker-search"
                    placeholder={t('Search agency name…')}
                    value={agencyQuery}
                    onChange={(e) => setAgencyQuery(e.target.value)}
                    autoFocus
                  />
                  {agencies === null ? (
                    agencyQuery ? <Loading /> : <p className="panel-note">{t('Start typing an agency name - there are thousands, so this always searches rather than listing them all.')}</p>
                  ) : (
                    <div className="picker-list">
                      {agencies.map((a) => (
                        <button key={a.agency} className="picker-item" disabled={authLoading} onClick={() => goAgency(a.agency)}>
                          <span>{td(a.agency)}</span>
                          <span className="picker-item-meta">{t('{n} works · {rate}% breach rate', { n: a.works_total.toLocaleString('en-IN'), rate: (a.breach_rate * 100).toFixed(0) })}</span>
                        </button>
                      ))}
                      {agencies.length === 0 && <p className="panel-note">{t('No agency name matches "{query}".', { query: agencyQuery })}</p>}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
