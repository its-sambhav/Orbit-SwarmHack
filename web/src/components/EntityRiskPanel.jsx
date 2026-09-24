import { useEffect, useMemo, useRef, useState } from 'react'
import { useLanguage } from '../i18n'

// name-column header: the singular of entityType. Just stripping the "s"
// turned "Agencies" into "Agencie", so "ies" is handled too; an entityType
// that isn't a plain plural ("States & UTs") passes `entityLabel` instead.
function singular(plural) {
  return plural.replace(/ies$/, 'y').replace(/s$/, '')
}

// an entity with no value yet (null) always sorts last, never as a fake 0
const desc = (key) => (a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity)
const SORTS = {
  risk: { label: 'Highest risk score', fn: desc('risk_score') },
  flagged: { label: 'Most works flagged', fn: desc('works_flagged') },
  rate: { label: 'Highest flagged %', fn: desc('breach_rate') },
  volume: { label: 'Most works', fn: desc('works_total') },
  alpha: { label: 'Alphabetical', fn: (a, b) => a.name.localeCompare(b.name) },
}

// heat-table shading for the risk-score chip: one navy hue in five steps,
// by the score's share of the highest score in the list (equal-width bins,
// so a darker chip always means a proportionally higher score)
const HEAT = ['var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)', 'var(--heat-5)']
const heatStep = (score, max) => (score == null || !max ? -1 : Math.min(4, Math.floor((score / max) * 5)))

const fmtPct = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`)
const fmtScore = (v) => (v == null ? '—' : v.toFixed(1))

/**
 * A searchable, sortable, scrollable ranked list of sub-jurisdictions
 * (states under MoSPI, districts under a state, agencies under a district).
 *
 * A heat table: each row is rank · name · works · flagged · flagged % ·
 * risk score, and the risk score sits in a chip shaded light-to-dark navy by
 * how high it is (legend under the table). Risk score is the engine's own
 * region score (engine/rollup.py: fair flagged rate x money-weighted Risk) -
 * the shading and the "risk" sort use it, not the flagged share, which has
 * its own labelled column. Rank follows the current sort.
 *
 * entities: [{ name, works_total, works_flagged, breach_rate, risk_score }]
 * entityType: plural noun ("States & UTs", "Districts", "Agencies").
 * entityLabel: optional override for the name-column header.
 * title: optional override for the heading.
 * onSelect(entity): click handler, receives one entity as-is.
 */
export function EntityRiskPanel({ entities, entityType, entityLabel, title, onSelect }) {
  const { t, td } = useLanguage()
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('risk')
  const listRef = useRef(null)

  const sorted = useMemo(() => [...(entities || [])].sort(SORTS[sortBy].fn), [entities, sortBy])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? sorted.filter((e) => e.name.toLowerCase().includes(q)) : sorted
  }, [sorted, search])
  // rank = position in the full sorted list, so a search keeps each row's real rank
  const rankOf = useMemo(() => new Map(sorted.map((e, i) => [e.name, i + 1])), [sorted])
  const topRisk = useMemo(() => [...(entities || [])].sort(SORTS.risk.fn)[0], [entities])
  const topFlagged = useMemo(() => [...(entities || [])].sort(SORTS.flagged.fn)[0], [entities])
  const maxScore = useMemo(() => Math.max(0, ...(entities || []).map((e) => e.risk_score ?? 0)), [entities])

  // re-sorting while scrolled a few rows down otherwise looks like the
  // dropdown did nothing - snap back to the top on any change.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [sortBy, search])

  return (
    <div className="chart-card">
      <h3>{title ? t(title) : t('{type} by risk', { type: t(entityType) })} ({entities ? entities.length : 0})</h3>
      {topRisk && topFlagged && (
        <p className="chart-insight">
          {t('Highest risk score: {a} ({s}). Most works flagged: {b} ({n}).', {
            a: td(topRisk.name), s: fmtScore(topRisk.risk_score), b: td(topFlagged.name), n: topFlagged.works_flagged.toLocaleString('en-IN'),
          })}
        </p>
      )}
      <div className="filters" style={{ marginBottom: 10 }}>
        <input
          type="search" placeholder={t('Search {type}…', { type: t(entityType).toLowerCase() })} value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label={t('Sort by')}>
          {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{t(v.label)}</option>)}
        </select>
      </div>
      {filtered.length ? (
        <>
          <div className="entity-head">
            <span>#</span>
            <span>{t(entityLabel || singular(entityType))}</span>
            <span>{t('Works')}</span>
            <span>{t('Flagged')}</span>
            <span>{t('Flagged %')}</span>
            <span>{t('Risk score')}</span>
          </div>
          <div className="rank-list entity-list" ref={listRef}>
            {filtered.map((e) => {
              const label = t('{name}: {flagged} of {total} works flagged ({pct}); risk score {score}', {
                name: td(e.name), flagged: e.works_flagged.toLocaleString('en-IN'),
                total: e.works_total.toLocaleString('en-IN'), pct: fmtPct(e.breach_rate), score: fmtScore(e.risk_score),
              })
              return (
                <button key={e.name} type="button" className="entity-row" onClick={() => onSelect(e)} aria-label={label}>
                  <span className="entity-rank num">{rankOf.get(e.name)}</span>
                  <span className="entity-name">{td(e.name)}</span>
                  <span className="entity-stat num">{e.works_total.toLocaleString('en-IN')}</span>
                  <span className="entity-stat num">{e.works_flagged.toLocaleString('en-IN')}</span>
                  <span className="entity-stat num">{fmtPct(e.breach_rate)}</span>
                  <span className="entity-score num">
                    <span className={`heat-chip${heatStep(e.risk_score, maxScore) >= 3 ? ' heat-chip-dark' : ''}`}
                      style={{ background: heatStep(e.risk_score, maxScore) >= 0 ? HEAT[heatStep(e.risk_score, maxScore)] : 'transparent' }}>
                      {fmtScore(e.risk_score)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="heat-legend">
            <span>{t('Risk score')}:</span>
            <span>{t('lower')}</span>
            {HEAT.map((c) => <span key={c} className="heat-legend-step" style={{ background: c }} />)}
            <span>{t('higher')}</span>
          </div>
          <p className="chart-footnote">{t('Risk score = fair flagged rate × money-weighted Risk of flagged works.')}</p>
        </>
      ) : (
        <div className="states-panel-empty">{t('No {type} match "{query}".', { type: t(entityType).toLowerCase(), query: search })}</div>
      )}
    </div>
  )
}
