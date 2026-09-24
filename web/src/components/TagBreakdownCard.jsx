import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLanguage } from '../i18n'

// severity is ordinal, so the three segments use the app's own severity
// scale (tokens.css --sev-*), the same colours as every SeverityChip - a
// "High" looks the same here as on a finding. Identity is never colour
// alone: the legend names each step.
const SEVERITIES = ['high', 'medium', 'low']
const SEV_LABEL = { high: 'High', medium: 'Medium', low: 'Low' }
// the card shows the top tags; the rest are one click away, so it never
// towers over the chart beside it or needs a scroll box that can crop
const TOP_N = 8
const FAMILY_LABEL = {
  timing: 'Timing', money: 'Money', guideline: 'Guideline', concentration: 'Concentration',
  documentation: 'Documentation', data_integrity: 'Data integrity',
}

/**
 * Findings by tag, counted in WORKS. One work can carry several tags, so
 * the bars add up to more than the flagged total - which is why this is a
 * ranked bar list and not a donut (a donut claims its slices are parts of
 * one whole). Each bar is split by the worst severity that tag has on each
 * work; the right-hand column is the tag's share of flagged works.
 *
 * summary: { flagged_works, items: [{ tag, family, works, high, medium, low }] }
 * (api/main.py tag_summary)
 * linkQuery: extra filters carried to the Anomalies page when a tag is
 * clicked ({ scope, state }), so its list matches this dashboard's view.
 */
export function TagBreakdownCard({ summary, title = 'Findings by tag', linkQuery = {} }) {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const openTag = (tag) => {
    const q = new URLSearchParams({ tag })
    for (const [k, v] of Object.entries(linkQuery)) if (v) q.set(k, v)
    navigate(`/anomalies?${q.toString()}`)
  }
  const [showAll, setShowAll] = useState(false)
  // { item, top, left } of the row under the pointer - drives the hover box
  const [hover, setHover] = useState(null)
  const items = summary?.items || []
  const shown = showAll ? items : items.slice(0, TOP_N)
  const flagged = summary?.flagged_works || 0
  const max = Math.max(1, ...items.map((i) => i.works))
  const mostHigh = items.reduce((a, b) => (b.high > (a?.high ?? -1) ? b : a), null)

  return (
    <div className="chart-card">
      <h3>{t(title)}</h3>
      <div className="tag-chart-sub">
        <span>{t('Works carrying each tag, out of {n} works with findings', { n: flagged.toLocaleString('en-IN') })}</span>
        <span className="tag-legend" aria-label={t('Severity')}>
          {SEVERITIES.map((s) => (
            <span key={s} className="tag-legend-item">
              <span className="tag-legend-swatch" style={{ background: `var(--sev-${s})` }} />{t(SEV_LABEL[s])}
            </span>
          ))}
        </span>
      </div>
      {items.length > 0 && (
        <p className="chart-insight">
          {t('Most common: {tag} ({pct} of works with findings).', {
            tag: t(items[0].tag), pct: `${Math.round((items[0].works / Math.max(flagged, 1)) * 100)}%`,
          })}
          {mostHigh && mostHigh.high > 0 && ' ' + t('Most high-severity works: {tag} ({n}).', { tag: t(mostHigh.tag), n: mostHigh.high.toLocaleString('en-IN') })}
        </p>
      )}
      {items.length ? (
        <div className="tag-list" onMouseLeave={() => setHover(null)}>
          {shown.map((it) => {
            const share = flagged ? it.works / flagged : null
            const label = t('{tag} ({family}): {works} works — {high} high, {medium} medium, {low} low; {share} of works with findings', {
              tag: t(it.tag), family: t(FAMILY_LABEL[it.family] || it.family || '—'),
              works: it.works.toLocaleString('en-IN'), high: it.high.toLocaleString('en-IN'),
              medium: it.medium.toLocaleString('en-IN'), low: it.low.toLocaleString('en-IN'),
              share: share == null ? '—' : `${(share * 100).toFixed(0)}%`,
            })
            return (
              <button
                type="button" key={it.tag} className="tag-row" aria-label={`${label} ${t('Open in Anomalies')}`}
                onClick={() => openTag(it.tag)}
                onMouseEnter={(e) => {
                  const bar = e.currentTarget.querySelector('.tag-row-bar')
                  setHover({ item: it, share, top: e.currentTarget.offsetTop + e.currentTarget.offsetHeight, left: bar.offsetLeft + bar.offsetWidth / 2 })
                }}
              >
                <span className="tag-row-name">{t(it.tag)}</span>
                <span className="tag-row-track" aria-hidden="true">
                  <span className="tag-row-bar" style={{ width: `${Math.max((it.works / max) * 100, 1.5)}%` }}>
                    {SEVERITIES.map((s) => (it[s] > 0 ? (
                      <span key={s} style={{ flexGrow: it[s], background: `var(--sev-${s})` }} />
                    ) : null))}
                  </span>
                </span>
                <span className="tag-row-value num">{it.works.toLocaleString('en-IN')}</span>
                <span className="tag-row-share num">{share == null ? '' : `${(share * 100).toFixed(0)}%`}</span>
              </button>
            )
          })}
          {/* same floating box as the Project Lifecycle chart; opens below the
              row so it never slides up under the page's top bar */}
          {hover && (
            <div className="lifecycle-tooltip tip-below" style={{ left: hover.left, top: hover.top + 4 }}>
              <div className="tooltip-sector">{t(hover.item.tag)}</div>
              {SEVERITIES.map((s) => (
                <div key={s} className="tooltip-row">
                  <span className="tooltip-swatch" style={{ background: `var(--sev-${s})` }} />
                  <span className="tooltip-metric">{t(SEV_LABEL[s])}:</span>
                  <strong className="tooltip-num">{hover.item[s].toLocaleString('en-IN')} {t('works')}</strong>
                </div>
              ))}
              <div className="tooltip-financial">
                {t('Total:')} <strong>{hover.item.works.toLocaleString('en-IN')} {t('works')}</strong>
                {hover.share != null && <> · {(hover.share * 100).toFixed(0)}% {t('of works with findings')}</>}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="states-panel-empty">{t('No findings in this view.')}</div>
      )}
      {items.length > TOP_N && (
        <button type="button" className="tag-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? t('Show top {n} tags', { n: TOP_N }) : t('Show all {n} tags', { n: items.length })}
        </button>
      )}
      <p className="chart-footnote">{t('Click a tag to see its works in Anomalies. A work can carry several tags, so these add up to more than the number of works with findings.')}</p>
    </div>
  )
}
