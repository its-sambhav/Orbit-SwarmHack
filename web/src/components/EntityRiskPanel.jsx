import { useEffect, useMemo, useRef, useState } from 'react'
import { useLanguage } from '../i18n'

// per-row badge colour - a scan aid only (GitHub-label-style), not a
// data-encoding channel: the entity's name and its 3 numbers are always
// shown as text, so this doesn't need the same CVD gate a chart series
// colour needs. Reuses the dataviz skill's own validated 8-hue categorical
// order (adjacent-pair safe in that sequence); a name hash doesn't preserve
// that adjacency guarantee once the list is re-sorted, so this is
// deliberately treated as decorative, never as the only cue.
const BADGE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
function badgeColor(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return BADGE_COLORS[h % BADGE_COLORS.length]
}

// name-column header: the singular of entityType. Just stripping the "s"
// turned "Agencies" into "Agencie", so "ies" is handled too; an entityType
// that isn't a plain plural ("States & UTs") passes `entityLabel` instead.
function singular(plural) {
  return plural.replace(/ies$/, 'y').replace(/s$/, '')
}

const SORTS = {
  // an entity with no score yet (null) sorts last rather than as a fake 0
  risk: { label: 'Highest risk', fn: (a, b) => (b.risk_score ?? -Infinity) - (a.risk_score ?? -Infinity) },
  volume: { label: 'Highest volume', fn: (a, b) => b.works_total - a.works_total },
  alpha: { label: 'Alphabetical', fn: (a, b) => a.name.localeCompare(b.name) },
}

// entityType/entityLabel/title arrive as plain English from the caller and
// are translated here; entity NAMES (states, districts, agencies) are data
// and stay as the API returned them.

/**
 * A searchable, sortable, scrollable ranked list of sub-jurisdictions
 * (states under MoSPI, districts under a state, agencies under a district)
 * by risk - generalizes NationalView.jsx's original inline `StatesPanel` so
 * every dashboard shares one implementation instead of copy-pasting it.
 *
 * entities: [{ name, works_total, works_flagged, breach_rate, risk_score }]
 * - callers whose own data uses different field names (e.g. district's
 *   agency_performance) map to this shape first; see StateView/DistrictView
 *   for the ~3-line adapters.
 * entityType: plural noun for the search placeholder/empty state/table
 *   header ("States & UTs", "Districts", "Agencies"), and the default title
 *   ("{entityType} by risk (N)") when `title` isn't given.
 * entityLabel: optional override for the name-column header when the singular
 *   of entityType isn't just entityType minus its plural ending ("State / UT").
 * title: optional override for the heading (kept exact on the National
 *   dashboard - "Top states by risk (N)" - rather than switching its
 *   existing wording just because this component is now shared).
 * onSelect(entity): click handler, receives one entity from the array as-is.
 */
export function EntityRiskPanel({ entities, entityType, entityLabel, title, onSelect }) {
  const { t, td } = useLanguage()
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('risk')
  const listRef = useRef(null)

  const filtered = useMemo(() => {
    if (!entities) return []
    const q = search.trim().toLowerCase()
    const rows = q ? entities.filter((e) => e.name.toLowerCase().includes(q)) : entities
    return [...rows].sort(SORTS[sortBy].fn)
  }, [entities, search, sortBy])

  // re-sorting while scrolled a few rows down otherwise looks like the
  // dropdown did nothing, since whatever rows now land in that same scroll
  // offset are what's still on screen - snap back to the top on any change.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [sortBy, search])

  return (
    <div className="chart-card">
      <h3>{title ? t(title) : t('{type} by risk', { type: t(entityType) })} ({entities ? entities.length : 0})</h3>
      <div className="filters" style={{ marginBottom: 10 }}>
        <input
          type="search" placeholder={t('Search {type}…', { type: t(entityType).toLowerCase() })} value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{t(v.label)}</option>)}
        </select>
      </div>
      {filtered.length ? (
        <>
          <div className="states-panel-head">
            <span /><span>{t(entityLabel || singular(entityType))}</span><span>{t('Total')}</span><span>{t('Flagged')}</span><span>{t('Risk %')}</span>
          </div>
          <div className="rank-list states-panel-list" ref={listRef}>
            {filtered.map((e) => (
              <button key={e.name} type="button" className="state-row" onClick={() => onSelect(e)}>
                <span className="state-row-swatch" style={{ background: badgeColor(e.name) }} />
                <span className="state-row-name">{td(e.name)}</span>
                <span className="state-row-stat">{e.works_total.toLocaleString('en-IN')}</span>
                <span className="state-row-stat">{e.works_flagged.toLocaleString('en-IN')}</span>
                <span className="state-row-pct">{e.breach_rate != null ? `${(e.breach_rate * 100).toFixed(0)}%` : '—'}</span>
                <span className="state-row-bar"><span style={{ width: `${e.breach_rate != null ? Math.max(e.breach_rate * 100, 2) : 0}%` }} /></span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="states-panel-empty">{t('No {type} match "{query}".', { type: t(entityType).toLowerCase(), query: search })}</div>
      )}
    </div>
  )
}
