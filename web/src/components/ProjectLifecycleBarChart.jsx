import { useMemo, useState } from 'react'
import { useLanguage } from '../i18n'
import { ScopeToggle } from './ScopeToggle'

// One column per lifecycle stage, grouped by sector. The three stages are
// one navy hue in three steps (lighter = earlier), so the eye reads each
// group left to right as "how far the works got"; high-risk works are a
// flag rather than a stage, so they're a fourth column in the site's
// severity "High" colour. Square-root scale, as the chart has always used:
// it compresses the biggest sector and lifts the small ones, so every bar is
// visible while taller still means more; gridlines are evenly spaced on
// screen and labelled with the real values. The chart says "√ scale", and
// each group's real total is printed on it. (The old stacked view, which
// added nested counts together, is gone.)
const METRICS = [
  { key: 'recommended', label: 'Recommended', color: 'var(--lc-recommended)' },
  { key: 'sanctioned', label: 'Sanctioned', color: 'var(--lc-sanctioned)' },
  { key: 'completed', label: 'Completed', color: 'var(--lc-completed)' },
  { key: 'highRisk', label: 'High risk', color: 'var(--sev-high)' },
]
const MODES = [{ value: 'count', label: 'Projects' }, { value: 'amount', label: 'Amount' }]

const fmtCr = (v) => `₹${(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} Cr`

// square-root axis: the top sits 15% above the largest value, and the four
// gridlines are evenly spaced in sqrt space - so evenly spaced on screen -
// with each labelled by the real value it stands for
function sqrtScale(values) {
  const top = Math.sqrt(Math.max(10, ...values) * 1.15)
  return { top, ticks: Array.from({ length: 5 }, (_, i) => ((top / 4) * i) ** 2) }
}

// split a sector name over two lines at the space nearest its middle
function twoLines(name) {
  if (name.length <= 14 || !name.includes(' ')) return [name]
  const mid = name.length / 2
  let best = -1
  for (let i = 0; i < name.length; i++) if (name[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i
  return [name.slice(0, best), name.slice(best + 1)]
}

/**
 * Project lifecycle & risk by sector: a grouped column chart on a
 * square-root scale (labelled "√ scale" on the chart). Projects /
 * Amount switches every column between work counts and rupees (₹ Cr).
 * Hovering a column shows that sector's four figures in the shared
 * floating box; only each group's total (recommended) is labelled on the
 * chart itself.
 *
 * sectors: [{ sector, recommended, recommended_cr, sanctioned, sanctioned_cr,
 *             completed, completed_cr, highRisk, highRisk_cr }]  (api.js mapCategoryBreakdown)
 */
export function ProjectLifecycleBarChart({ sectors = [], title = 'Project Lifecycle & Risk Breakdown' }) {
  const { t } = useLanguage()
  const [mode, setMode] = useState('count')
  const [hover, setHover] = useState(null) // { sector, x, y }

  const val = (s, key) => (mode === 'count' ? s[key] || 0 : s[`${key}_cr`] || 0)
  const show = (v) => (mode === 'count' ? Math.round(v).toLocaleString('en-IN') : fmtCr(v))
  const short = (v) => {
    if (v >= 10000) return `${Math.round(v / 1000).toLocaleString('en-IN')}k`
    if (v >= 1000) return `${(v / 1000).toLocaleString('en-IN', { maximumFractionDigits: 1 })}k`
    return Math.round(v).toLocaleString('en-IN')
  }
  const axisLabel = (v) => (mode === 'amount' ? `₹${short(v)} Cr` : short(v))

  // a sector's size: its recommended works, or its sanctioned ones where a
  // view has no recommendation stage (an agency's works start at sanction)
  const size = (s) => Math.max(s.recommended || 0, s.sanctioned || 0)
  const rows = useMemo(() => [...sectors].sort((a, b) => size(b) - size(a)), [sectors])
  const { top, ticks } = sqrtScale(rows.flatMap((s) => METRICS.map((m) => val(s, m.key))))
  const totals = Object.fromEntries(METRICS.map((m) => [m.key, rows.reduce((acc, s) => acc + val(s, m.key), 0)]))

  // one-line takeaway from the data: the biggest sector, and which sectors
  // finish the most / least of what they sanction (counts, whatever the mode)
  // at least 5 sanctioned works, so one or two works can't read as "100%" / "0%"
  const done = rows.filter((s) => s.sanctioned >= 5).map((s) => ({ s, rate: s.completed / s.sanctioned }))
  const best = done.reduce((a, b) => (b.rate > a.rate ? b : a), done[0])
  const worst = done.reduce((a, b) => (b.rate < a.rate ? b : a), done[0])

  // geometry (viewBox units; the SVG scales to the card's width)
  const W = 600, H = 265
  const pad = { top: 26, right: 10, bottom: 53, left: 62 }
  const plotW = W - pad.left - pad.right, plotH = H - pad.top - pad.bottom
  const groupW = plotW / Math.max(rows.length, 1)
  const barW = Math.min(18, (groupW - 22) / METRICS.length)
  const gap = 2
  // share of the plot height on the sqrt scale; 0 draws nothing
  const frac = (v) => (v > 0 ? Math.sqrt(v) / top : 0)
  const y = (v) => pad.top + plotH - frac(v) * plotH

  return (
    <div className="chart-card project-lifecycle-card">
      <div className="lc-head">
        <div>
          {/* the default title is plain English; per-entity titles callers
              build are already translated and fall through t() unchanged */}
          <h3 style={{ margin: 0 }}>{t(title)}</h3>
          <span className="lc-sub">{t('Works at each stage in every sector, and how many are high risk')}</span>
        </div>
        <ScopeToggle scopes={MODES} value={mode} onChange={setMode} includeAll={false} size="sm" />
      </div>

      {rows.length > 0 && size(rows[0]) > 0 && (
        <p className="chart-insight">
          {t('{big} has the most works ({n}).', { big: t(rows[0].sector), n: size(rows[0]).toLocaleString('en-IN') })}
          {best && best !== worst && ' ' + t('{best} completes {bp} of what it sanctions; {worst} only {wp}.', {
            best: t(best.s.sector), bp: `${Math.round(best.rate * 100)}%`,
            worst: t(worst.s.sector), wp: `${Math.round(worst.rate * 100)}%`,
          })}
        </p>
      )}
      <div className="lc-legend">
        {METRICS.map((m) => (
          <span key={m.key} className="lc-legend-item">
            <span className="lc-swatch" style={{ background: m.color }} />
            {t(m.label)} <strong className="num">{show(totals[m.key])}</strong>
          </span>
        ))}
      </div>

      {rows.length ? (
        <div className="lc-chart" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} className="lc-svg" role="img" aria-label={t(title)}>
            <text x={2} y={13} className="lc-scale-note">{t('√ scale')}</text>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'lc-axis' : 'lc-grid'} />
                <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" className="lc-tick">{axisLabel(v)}</text>
              </g>
            ))}
            {rows.map((s, i) => {
              const gx = pad.left + i * groupW + (groupW - (barW * METRICS.length + gap * (METRICS.length - 1))) / 2
              const cx = pad.left + (i + 0.5) * groupW
              return (
                <g
                  key={s.sector} className={`lc-group${hover?.sector === s ? ' active' : ''}`}
                  onMouseEnter={() => setHover({ sector: s, x: cx, y: y(Math.max(...METRICS.map((m) => val(s, m.key)))) })}
                >
                  {/* whole-group hit area, bigger than the bars */}
                  <rect x={pad.left + i * groupW} y={pad.top} width={groupW} height={plotH} className="lc-hit" />
                  {METRICS.map((m, j) => {
                    const v = val(s, m.key)
                    const h = Math.max(frac(v) * plotH, v > 0 ? 2 : 0) // 2px floor: a real non-zero value never vanishes
                    return <rect key={m.key} x={gx + j * (barW + gap)} y={pad.top + plotH - h} width={barW} height={h} rx={3} fill={m.color} />
                  })}
                  <text x={cx} y={y(Math.max(...METRICS.map((m) => val(s, m.key)))) - 7} textAnchor="middle" className="lc-value">{axisLabel(Math.max(val(s, 'recommended'), val(s, 'sanctioned')))}</text>
                  <text x={cx} y={H - pad.bottom + 19} textAnchor="middle" className="lc-xlabel">
                    {twoLines(t(s.sector)).map((line, k) => <tspan key={k} x={cx} dy={k ? 17 : 0}>{line}</tspan>)}
                  </text>
                </g>
              )
            })}
          </svg>

          {hover && (
            <div className="lifecycle-tooltip" style={{ left: `${(hover.x / W) * 100}%`, top: `${Math.max((hover.y / H) * 100 - 4, 4)}%` }}>
              <div className="tooltip-sector">{t(hover.sector.sector)}</div>
              {METRICS.map((m) => (
                <div key={m.key} className="tooltip-row">
                  <span className="tooltip-swatch" style={{ background: m.color }} />
                  <span className="tooltip-metric">{t(m.label)}:</span>
                  <strong className="tooltip-num">{(hover.sector[m.key] || 0).toLocaleString('en-IN')} {t('works')}</strong>
                  <span className="tooltip-metric">· {fmtCr(hover.sector[`${m.key}_cr`])}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="states-panel-empty">{t('No works in this view.')}</div>
      )}
    </div>
  )
}
