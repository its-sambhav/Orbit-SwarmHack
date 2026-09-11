import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

/** Fixed nav + collapsible drawer shared by every MoSPI page (Overview, Map),
 * so the two pages stay visually and behaviourally in sync. `drawerLinks` is
 * page-specific (each page only offers links to sections that actually exist
 * on it); the search bar's resolution logic is the same everywhere. */
export function MospiNav({ scope, subtitle, scopeWorksTotal, searchIndex, drawerLinks }) {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  function handleSearch(raw) {
    const q = raw.trim().toLowerCase()
    if (!q) return
    const match = searchIndex.find((o) => o.name.toLowerCase() === q)
      || searchIndex.find((o) => o.name.toLowerCase().includes(q))
    if (!match) return
    if (match.type === 'constituency') navigate(`/constituency/${match.id}?scope=${encodeURIComponent(scope)}`)
    else navigate(`/state/${encodeURIComponent(match.name)}`)
  }

  return (
    <>
      <nav className="mospi-nav">
        <button className="mospi-menu-btn" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <span /><span /><span />
        </button>

        <div className="mospi-nav-brand">
          <div className="mospi-nav-title">MPLADS Review</div>
          <div className="mospi-nav-subtitle">{subtitle}</div>
        </div>

        <form className="mospi-search" onSubmit={(e) => { e.preventDefault(); handleSearch(searchQuery) }}>
          <input
            type="search"
            list="mospi-search-options"
            placeholder="Search state or constituency…"
            aria-label="Search state or constituency"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <datalist id="mospi-search-options">
            {searchIndex.map((o) => <option key={`${o.type}-${o.name}`} value={o.name} />)}
          </datalist>
        </form>

        <div className="mospi-nav-actions">
          <Link className="switch-role-link" to="/">Switch role</Link>
          <div className="mospi-profile">
            <span className="mospi-profile-avatar">M</span>
            <span className="mospi-profile-text">
              <span className="mospi-profile-name">MoSPI Authority</span>
              <span className="mospi-profile-role">Government of India</span>
            </span>
          </div>
        </div>
      </nav>

      {menuOpen && <div className="mospi-drawer-backdrop" onClick={() => setMenuOpen(false)} />}
      <aside className={`mospi-drawer${menuOpen ? ' open' : ''}`} aria-hidden={!menuOpen}>
        <div className="mospi-drawer-section">
          <h3>Navigate</h3>
          {drawerLinks.map((l) => (
            <button key={l.label} className="mospi-drawer-link" onClick={() => { l.onClick(); setMenuOpen(false) }}>
              {l.label}
            </button>
          ))}
        </div>
        <div className="mospi-drawer-section">
          <h3>Scope</h3>
          <div className="mospi-drawer-meta">{scope === 'all' ? 'All scopes (17th + 18th Lok Sabha)' : scope}</div>
          {scopeWorksTotal != null && <div className="mospi-drawer-meta">{scopeWorksTotal.toLocaleString('en-IN')} works tracked</div>}
        </div>
      </aside>
    </>
  )
}
