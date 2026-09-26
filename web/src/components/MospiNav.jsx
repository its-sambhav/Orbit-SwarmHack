import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, clearAuthToken, formatRupees, getAuthInfo, homePath } from '../api'
import { useLanguage } from '../i18n'

const iconProps = {
  width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}
const MenuIcon = () => <svg {...iconProps}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
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
const WarningIcon = () => (
  <svg {...iconProps}>
    <path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4" /><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
  </svg>
)
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
  Anomalies: WarningIcon,
  'MP Audits': ClipboardIcon,
  Works: ClipboardIcon,
  Reports: DocumentIcon,
}
const iconFor = (label) => { const Icon = NAV_ICON[label] || DotIcon; return <Icon /> }

// callers (NationalView, StateView, StateMapView, ...) still pass every
// drawerLinks label and profileRole in plain English, same as NAV_ICON's own
// lookup above - translating here, by matching that one fixed English
// vocabulary to a STRINGS key, means every one of those view files keeps
// working unchanged instead of importing i18n itself.
const DRAWER_LABEL_KEY = {
  Overview: 'drawer.overview', Map: 'drawer.map', 'Map (all India)': 'drawer.mapAllIndia',
  Anomalies: 'drawer.anomalies', 'MP Audits': 'drawer.mpAudits', Works: 'drawer.works', Reports: 'drawer.reports',
}
const ROLE_LABEL_KEY = {
  'State Nodal Authority': 'role.state', 'District Authority': 'role.district',
  'Implementing Agency': 'role.agency', 'Member of Parliament': 'role.mp',
}

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

/** Fixed nav + a hidden-by-default left rail shared by every page - MoSPI's
 * own pages (Overview, Map, MP Audits, CaseFile, Constituency) keep the
 * "MoSPI Authority / Government of India" identity, national search, and
 * cross-page navigation by leaving the role-identity/search props at their
 * defaults. A role-scoped dashboard (State/District/Agency/MP) passes its
 * own identity, turns the search bar off (it has nothing in scope to search
 * across roles for), and passes only in-page anchors in drawerLinks - never
 * links to another role's pages, since a role has no authorized access to
 * MoSPI's or another role's data.
 *
 * The rail (this file's <aside>) renders those same drawerLinks as an
 * overlay drawer, toggled solely by the menu button in the nav bar itself
 * (no in-rail toggle, no hover-to-open) - closed it's zero-width and reserves
 * no page margin anywhere, open it shows icon + label and overlays whatever
 * page is underneath (a scrim behind it closes it on an outside click).
 * Account switching now lives inside the profile menu as "Log out", not a
 * standing nav-bar link. */
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
  const { lang, setLang, languages, t, td } = useLanguage()

  const auth = getAuthInfo()

  useEffect(() => {
    let cancelled = false
    api.alertsLatest().then((d) => { if (!cancelled) setDigest(d) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // comments that mention this desk - only for a signed-in desk, since the
  // server picks the office from the caller's own token
  const [mentions, setMentions] = useState(null)
  useEffect(() => {
    if (!auth?.token) return undefined
    let cancelled = false
    api.mentions().then((d) => { if (!cancelled) setMentions(d) }).catch(() => {})
    return () => { cancelled = true }
  }, [auth?.token])

  function toggleAlerts() {
    const opening = !alertsOpen
    setAlertsOpen(opening)
    setProfileOpen(false)
    // opening the bell reads the mentions: the badge clears, while the items
    // keep their "new" mark until the popover closes
    if (opening && mentions?.unread) {
      api.markMentionsSeen().then(() => setMentions((m) => m && { ...m, unread: 0 })).catch(() => {})
    }
  }

  function openMention(m) {
    setAlertsOpen(false)
    setMentions((cur) => cur && { ...cur, items: cur.items.map((i) => ({ ...i, unread: false })) })
    const roleQuery = auth?.role && auth.role !== 'mospi' && m.role_name
      ? `&role=${auth.role}&role_name=${encodeURIComponent(m.role_name)}` : ''
    navigate(`/work/${m.work_number}?scope_house=${encodeURIComponent(m.scope_house)}&scope_tenure=${encodeURIComponent(m.scope_tenure)}${roleQuery}`)
  }

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
  const badgeCount = alerts.count + (mentions?.unread || 0)
  const expiresAt = auth?.token ? decodeTokenExp(auth.token) : null

  return (
    <>
      <nav className="mospi-nav">
        <button
          type="button" className="mospi-icon-btn" aria-label={railOpen ? t('nav.closeMenu') : t('nav.openMenu')}
          aria-expanded={railOpen} onClick={() => setRailOpen((v) => !v)}
        >
          <MenuIcon />
        </button>

        {/* the emblem is the home button: back to this desk's own dashboard */}
        <Link to={homePath(auth)} className="mospi-nav-home" aria-label={t('Home')} title={t('Home')}>
          <img className="mospi-nav-emblem" src="/emblem.svg" alt="" />
        </Link>

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
                placeholder={t('nav.searchPlaceholder')}
                aria-label={t('nav.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </form>
          )}

          <div className="mospi-popover-anchor" ref={alertsRef}>
            <button
              type="button" className="mospi-icon-btn" aria-label={t('nav.alertsAria')} aria-haspopup="true"
              aria-expanded={alertsOpen} onClick={toggleAlerts}
            >
              <BellIcon />
              {badgeCount > 0 && <span className="mospi-badge">{badgeCount > 99 ? '99+' : badgeCount}</span>}
            </button>
            {alertsOpen && (
              <div className="mospi-popover mospi-alerts-popover" role="menu">
                {mentions?.items?.length > 0 && (
                  <>
                    <div className="mospi-popover-header">{t('Mentions')}</div>
                    <ul className="mospi-alert-list mospi-mention-list">
                      {mentions.items.slice(0, 5).map((m) => (
                        <li key={m.comment_id}>
                          <button type="button" className="mospi-alert-item mospi-mention-item" onClick={() => openMention(m)}>
                            <span className="mospi-mention-who">
                              {m.unread && <span className="mospi-mention-dot" aria-label={t('New')} />}
                              {[t(m.author_role), m.author_entity && td(m.author_entity)].filter(Boolean).join(' · ')}
                              <span className="mospi-mention-work">{t('Work #{n}', { n: m.work_number })}</span>
                            </span>
                            <span className="mospi-mention-body">{m.body}</span>
                            <span className="mospi-alert-meta">
                              {[m.constituency, m.district, m.state].filter(Boolean).map(td).join(' · ')}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="mospi-popover-header">
                  {t('nav.alertsTitle')}
                  {alerts.kind !== 'national' && alerts.kind !== 'none' && alerts.kind !== 'unsupported' && (
                    <span className="mospi-popover-header-scope"> · {alerts.label}</span>
                  )}
                </div>
                {alerts.kind === 'unsupported' && (
                  <p className="mospi-popover-empty">{t('nav.alertsUnsupported')}</p>
                )}
                {alerts.kind === 'none' && <p className="mospi-popover-empty">{t('nav.alertsLoading')}</p>}
                {(alerts.kind === 'national' || alerts.kind === 'state' || alerts.kind === 'district') && (
                  alerts.count === 0 ? (
                    <p className="mospi-popover-empty">{t('nav.alertsEmpty')}</p>
                  ) : (
                    <ul className="mospi-alert-list">
                      {alerts.findings.slice(0, 6).map((f) => (
                        <li key={f.finding_id}>
                          <button
                            type="button" className="mospi-alert-item"
                            onClick={() => { setAlertsOpen(false); if (f.state) navigate(`/mospi/map?state=${encodeURIComponent(f.state)}`) }}
                          >
                            <span className="mospi-alert-tag">{t(f.tag)}</span>
                            <span className="mospi-alert-meta">
                              {[f.mp_name, f.district, f.state].filter(Boolean).map(td).join(' · ')}
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
              type="button" className="mospi-icon-btn mospi-profile-trigger" aria-label={t('nav.accountAria')}
              aria-haspopup="true" aria-expanded={profileOpen} onClick={() => { setProfileOpen((v) => !v); setAlertsOpen(false) }}
            >
              <span className="mospi-profile-avatar">{avatarLetter}</span>
            </button>
            {profileOpen && (
              <div className="mospi-popover mospi-profile-popover" role="menu">
                <div className="mospi-profile-identity">
                  <span className="mospi-profile-avatar">{avatarLetter}</span>
                  <span>
                    {/* profileName is an entity name (a state, district, agency or MP)
                        for every role but MoSPI's own default - t() translates that one
                        default and passes real names through untouched */}
                    <span className="mospi-profile-name" title={td(profileName)}>{td(profileName)}</span>
                    <span className="mospi-profile-role">{ROLE_LABEL_KEY[profileRole] ? t(ROLE_LABEL_KEY[profileRole]) : t(profileRole)}</span>
                  </span>
                </div>
                {expiresAt && (
                  <div className="mospi-popover-note">
                    {t('nav.sessionEnds')} {expiresAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}

                <div className="mospi-popover-section">
                  <div className="mospi-popover-label"><GlobeIcon /> {t('nav.language')}</div>
                  <div className="mospi-lang-switch">
                    {languages.map((l) => (
                      <button
                        key={l.code} type="button" className={lang === l.code ? 'active' : ''}
                        aria-pressed={lang === l.code} onClick={() => setLang(l.code)}
                      >
                        {l.native}
                      </button>
                    ))}
                  </div>
                </div>

                <button type="button" className="mospi-popover-logout" onClick={logout}>
                  <LogoutIcon /> {t('nav.logout')}
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <aside className={`app-rail${railOpen ? ' open' : ''}`} aria-label={t('Section navigation')}>
        <nav className="app-rail-links">
          {drawerLinks.map((l) => {
            const label = DRAWER_LABEL_KEY[l.label] ? t(DRAWER_LABEL_KEY[l.label]) : l.label
            return (
              <button
                key={l.label} type="button" className="app-rail-link" title={label}
                onClick={() => { l.onClick(); setRailOpen(false) }}
              >
                {iconFor(l.label)}
                <span className="app-rail-link-label">{label}</span>
              </button>
            )
          })}
        </nav>
      </aside>
      {railOpen && <div className="app-rail-scrim" onClick={() => setRailOpen(false)} />}
    </>
  )
}
