import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, clearAuthToken, formatRupees, getAuthInfo } from '../api'

const iconProps = {
  width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}
const ChevronIcon = (p) => <svg {...iconProps} {...p}><path d="M9 6l6 6-6 6" /></svg>
const HomeIcon = () => <svg {...iconProps}><path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v9h5v-5h2v5h5v-9" /></svg>
const MapPinIcon = () => (
  <svg {...iconProps}><path d="M12 21s7-6.3 7-11.5A7 7 0 0 0 5 9.5C5 14.7 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.4" /></svg>
)
const ClipboardIcon = () => (
  <svg {...iconProps}><rect x="6" y="4" width="12" height="17" rx="1.5" /><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M9 11h6M9 15h6" /></svg>
)
const DocumentIcon = () => (
  <svg {...iconProps}><path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v4h4M9 13h6M9 17h6" /></svg>
)
const DotIcon = () => <svg {...iconProps}><circle cx="12" cy="12" r="3" /></svg>
const BellIcon = () => (
  <svg {...iconProps}><path d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10z" /><path d="M10 19a2 2 0 0 0 4 0" /></svg>
)
const GlobeIcon = () => (
  <svg {...iconProps} width={16} height={16}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" /></svg>
)
const LogoutIcon = () => (
  <svg {...iconProps} width={16} height={16}><path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" /><path d="M16 17l5-5-5-5M21 12H9" /></svg>
)
const SearchIcon = () => <svg {...iconProps} width={16} height={16}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>

const NAV_ICON = {
  Overview: HomeIcon,
  Map: MapPinIcon,
  'Map (all India)': MapPinIcon,
  'MP Audits': ClipboardIcon,
  Reports: DocumentIcon,
}
const iconFor = (label) => { const Icon = NAV_ICON[label] || DotIcon; return <Icon /> }

// this app's tokens sign every issued token with {role, entity, exp} (see
// api/auth.py's issue_token) - decoding it client-side to show a session
// expiry is reading our own already-trusted claim back, not verifying
// anything new, so no signature check is needed here (the server still
// checks the signature on every request).
function decodeTokenExp(token) {
  try {
    const payloadB64 = token.split('.', 1)[0]
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (payloadB64.length % 4)) % 4)
    const payload = JSON.parse(atob(padded))
    return payload.exp ? new Date(payload.exp * 1000) : null
  } catch {
    return null
  }
}

// alerts/latest is one national push digest (engine/alerts.py), computed
// with no per-role access check on the API side - narrowing it to the
// caller's own jurisdiction here keeps a state/district sign-in from seeing
// another state's newly-flagged high-severity works. Agency/MP tokens carry
// no state field to key off (only an agency/MP name), so there's no safe
// slice of this national-by-state digest to show them yet.
function scopedAlerts(digest, auth) {
  if (!digest) return { kind: 'none' }
  if (!auth || auth.role === 'mospi') {
    return { kind: 'national', count: digest.national.new_high_severity_count, findings: digest.national.top_findings }
  }
  if (auth.role === 'state') {
    const sec = digest.by_state.find((s) => (s.state || '').toLowerCase() === (auth.entity || '').toLowerCase())
    return { kind: 'state', label: auth.entity, count: sec?.new_high_severity_count ?? 0, findings: sec?.top_findings ?? [] }
  }
  if (auth.role === 'district') {
    const [state, district] = (auth.entity || '').split('|')
    const sec = digest.by_state.find((s) => (s.state || '').toLowerCase() === (state || '').toLowerCase())
    const findings = (sec?.top_findings ?? []).filter((f) => (f.district || '').toLowerCase() === (district || '').toLowerCase())
    return { kind: 'district', label: `${district}, ${state}`, count: findings.length, findings }
  }
  return { kind: 'unsupported' }
}

/** Fixed nav + persistent left rail shared by every page - MoSPI's own pages
 * (Overview, Map, MP Audits, CaseFile, Constituency) keep the "MoSPI
 * Authority / Government of India" identity, national search, and
 * cross-page navigation by leaving the role-identity/search props at their
 * defaults. A role-scoped dashboard (State/District/Agency/MP) passes its
 * own identity, turns the search bar off (it has nothing in scope to search
 * across roles for), and passes only in-page anchors in drawerLinks - never
 * links to another role's pages, since a role has no authorized access to
 * MoSPI's or another role's data.
 *
 * The rail (this file's <aside>) renders those same drawerLinks as a
 * persistent, collapsible sidebar instead of the old click-to-open overlay
 * drawer: collapsed it's icons only, expanded (its own toggle, bottom of the
 * rail) it shows icon + label. Every page's own root (.mospi-page) reserves
 * --rail-w of left margin for its collapsed width; app.css's
 * .mospi-map-page-body does the same explicitly (it's position:fixed, so it
 * doesn't inherit that margin). Account switching now lives inside the
 * profile menu as "Log out", not a standing nav-bar link. */
export function MospiNav({
  // scopeWorksTotal: no longer rendered (it lived in the old drawer's
  // "Scope" section, dropped when the drawer became a pure nav rail - every
  // page's own toolbar already shows its own scope/work counts). Left out
  // of destructuring on purpose; callers still passing it is harmless.
  scope, subtitle, searchIndex = [], drawerLinks = [],
  profileName = 'MoSPI Authority', profileRole = 'Government of India',
  avatarLetter = 'M', showSearch = true,
}) {
  const navigate = useNavigate()
  const [railOpen, setRailOpen] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [digest, setDigest] = useState(null)
  const alertsRef = useRef(null)
  const profileRef = useRef(null)

  const auth = getAuthInfo()

  useEffect(() => {
    let cancelled = false
    api.alertsLatest().then((d) => { if (!cancelled) setDigest(d) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // one listener closes whichever popover/rail is open on an outside click
  // or Escape - the same interaction all three already share.
  useEffect(() => {
    function onPointerDown(e) {
      if (alertsRef.current && !alertsRef.current.contains(e.target)) setAlertsOpen(false)
      if (profileRef.current && !profileRef.current.contains(e.target)) setProfileOpen(false)
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') { setAlertsOpen(false); setProfileOpen(false); setRailOpen(false) }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  function handleSearch(raw) {
    const q = raw.trim().toLowerCase()
    if (!q) return
    const match = searchIndex.find((o) => o.name.toLowerCase() === q)
      || searchIndex.find((o) => o.name.toLowerCase().includes(q))
    if (!match) return
    if (match.type === 'constituency') navigate(`/constituency/${match.id}?scope=${encodeURIComponent(scope)}`)
    else navigate(`/state/${encodeURIComponent(match.name)}`)
  }

  function logout() {
    clearAuthToken()
    navigate('/')
  }

  const alerts = scopedAlerts(digest, auth)
  const expiresAt = auth?.token ? decodeTokenExp(auth.token) : null

  return (
    <>
      <nav className="mospi-nav">
        <img className="mospi-nav-emblem" src="/emblem.svg" alt="Government of India" />

        <div className="mospi-nav-brand">
          <div className="mospi-nav-title">MPLADS Review</div>
          <div className="mospi-nav-subtitle">{subtitle}</div>
        </div>

        <div className="mospi-nav-actions">
          {showSearch && (
            <form className="mospi-search" onSubmit={(e) => { e.preventDefault(); handleSearch(searchQuery) }}>
              <SearchIcon />
              <input
                type="search"
                placeholder="Search state or constituency…"
                aria-label="Search state or constituency"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </form>
          )}

          <div className="mospi-popover-anchor" ref={alertsRef}>
            <button
              type="button" className="mospi-icon-btn" aria-label="Alerts" aria-haspopup="true"
              aria-expanded={alertsOpen} onClick={() => { setAlertsOpen((v) => !v); setProfileOpen(false) }}
            >
              <BellIcon />
              {alerts.count > 0 && <span className="mospi-badge">{alerts.count > 99 ? '99+' : alerts.count}</span>}
            </button>
            {alertsOpen && (
              <div className="mospi-popover mospi-alerts-popover" role="menu">
                <div className="mospi-popover-header">
                  New high-severity findings
                  {alerts.kind !== 'national' && alerts.kind !== 'none' && alerts.kind !== 'unsupported' && (
                    <span className="mospi-popover-header-scope"> · {alerts.label}</span>
                  )}
                </div>
                {alerts.kind === 'unsupported' && (
                  <p className="mospi-popover-empty">Alerts aren't scoped for this role yet - see the MoSPI or State dashboard.</p>
                )}
                {alerts.kind === 'none' && <p className="mospi-popover-empty">Loading…</p>}
                {(alerts.kind === 'national' || alerts.kind === 'state' || alerts.kind === 'district') && (
                  alerts.count === 0 ? (
                    <p className="mospi-popover-empty">No new high-severity findings since the last pipeline run.</p>
                  ) : (
                    <ul className="mospi-alert-list">
                      {alerts.findings.slice(0, 6).map((f) => (
                        <li key={f.finding_id}>
                          <button
                            type="button" className="mospi-alert-item"
                            onClick={() => { setAlertsOpen(false); if (f.state) navigate(`/mospi/map?state=${encodeURIComponent(f.state)}`) }}
                          >
                            <span className="mospi-alert-tag">{f.tag}</span>
                            <span className="mospi-alert-meta">
                              {[f.mp_name, f.district, f.state].filter(Boolean).join(' · ')}
                            </span>
                            <span className="mospi-alert-amount num">{formatRupees(f.financial_exposure)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                )}
              </div>
            )}
          </div>

          <div className="mospi-popover-anchor" ref={profileRef}>
            <button
              type="button" className="mospi-icon-btn mospi-profile-trigger" aria-label="Account menu"
              aria-haspopup="true" aria-expanded={profileOpen} onClick={() => { setProfileOpen((v) => !v); setAlertsOpen(false) }}
            >
              <span className="mospi-profile-avatar">{avatarLetter}</span>
              <ChevronIcon className="mospi-profile-chevron" />
            </button>
            {profileOpen && (
              <div className="mospi-popover mospi-profile-popover" role="menu">
                <div className="mospi-profile-identity">
                  <span className="mospi-profile-avatar">{avatarLetter}</span>
                  <span>
                    <span className="mospi-profile-name" title={profileName}>{profileName}</span>
                    <span className="mospi-profile-role">{profileRole}</span>
                  </span>
                </div>
                {expiresAt && (
                  <div className="mospi-popover-note">
                    Session ends {expiresAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}

                <div className="mospi-popover-section">
                  <div className="mospi-popover-label"><GlobeIcon /> Language</div>
                  <div className="mospi-lang-switch">
                    <button type="button" className="active" aria-pressed="true">English</button>
                    <button type="button" disabled title="Not yet available in this prototype">हिन्दी <span>Soon</span></button>
                  </div>
                </div>

                <button type="button" className="mospi-popover-logout" onClick={logout}>
                  <LogoutIcon /> Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <aside className={`app-rail${railOpen ? ' open' : ''}`} aria-label="Section navigation">
        <nav className="app-rail-links">
          {drawerLinks.map((l) => (
            <button
              key={l.label} type="button" className="app-rail-link" title={l.label}
              onClick={() => { l.onClick(); setRailOpen(false) }}
            >
              {iconFor(l.label)}
              <span className="app-rail-link-label">{l.label}</span>
            </button>
          ))}
        </nav>
        <button
          type="button" className="app-rail-toggle" aria-expanded={railOpen}
          aria-label={railOpen ? 'Collapse menu' : 'Expand menu'} onClick={() => setRailOpen((v) => !v)}
        >
          <ChevronIcon className="app-rail-toggle-icon" />
        </button>
      </aside>
      {railOpen && <div className="app-rail-scrim" onClick={() => setRailOpen(false)} />}
    </>
  )
}
