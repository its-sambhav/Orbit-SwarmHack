import { useState } from 'react'
import { useLanguage } from '../i18n'

// The three current stages share one navy step. "Reached sanction" is the
// roll-up of the two stages after it (in progress + completed), so it wears
// the dark accent to set it apart from the bars it overlaps with.
const STAGES = [
  { key: 'awaiting_sanction', label: 'Awaiting sanction', hint: 'not yet sanctioned', color: 'var(--lc-sanctioned)' },
  { key: 'reached_sanction', label: 'Reached sanction', hint: 'in progress + completed', color: 'var(--accent)', rollup: true },
  { key: 'in_progress', label: 'In progress', hint: 'not yet completed', color: 'var(--lc-sanctioned)' },
  { key: 'completed', label: 'Completed', hint: 'marked complete', color: 'var(--lc-sanctioned)' },
]
const LINE = 'var(--sev-high)'
const fmtPct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const short = (v) => {
  if (v >= 10000) return `${Math.round(v / 1000).toLocaleString('en-IN')}k`
  if (v >= 1000) return `${(v / 1000).toLocaleString('en-IN', { maximumFractionDigits: 1 })}k`
  return Math.round(v).toLocaleString('en-IN')
}

// the smallest 1 / 2 / 2.5 / 5 x 10^k step that fits `max` in four gridlines
function niceStep(max) {
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)
}

// a stage's hint split at the space nearest its middle, so the four hints
// don't run into each other under their columns
function twoLines(text) {
  if (text.length <= 14 || !text.includes(' ')) return [text]
  const mid = text.length / 2
  let best = -1
  for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i
  return [text.slice(0, best), text.slice(best + 1)]
}

// a bar with 4px rounded corners on its data end, square on the baseline
function barPath(x, y, w, h) {
  const r = Math.min(4, h, w / 2)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

/**
 * Where works are in the pipeline: a column per stage for how many works
 * are there (left axis), with a line for the share of them that are flagged
 * (right axis, %). Awaiting sanction, in progress and completed each count a
 * work once, at its current stage; reached sanction is in progress +
 * completed together. Hovering a column shows its figures, and the
 * conversion rate into that stage where there is one.
 *
 * pipeline: { total, stages: [{ key, works, flagged }], sanction_rate, completion_rate }
 * (api/main.py pipeline_summary)
 */
export function PipelineCard({ pipeline, title = 'Where works are in the pipeline' }) {
  const { t } = useLanguage()
  const [hover, setHover] = useState(null) // index into rows
  if (!pipeline) return null
  const total = pipeline.total || 0
  const byKey = Object.fromEntries(pipeline.stages.map((s) => [s.key, s]))
  const none = { works: 0, flagged: 0 }
  const awaiting = byKey.awaiting_sanction || none
  const inProgress = byKey.in_progress || none
  const completed = byKey.completed || none
  const counts = {
    awaiting_sanction: awaiting,
    reached_sanction: { works: inProgress.works + completed.works, flagged: inProgress.flagged + completed.flagged },
    in_progress: inProgress,
    completed,
  }
  const rates = {
    reached_sanction: { rate: pipeline.sanction_rate, text: 'of recommended works were sanctioned' },
    completed: { rate: pipeline.completion_rate, text: 'of sanctioned works were completed' },
  }
  const rows = STAGES.map((s) => {
    const c = counts[s.key]
    return { ...s, works: c.works, flagged: c.flagged, share: c.works ? c.flagged / c.works : null }
  })

  const worstStep = (pipeline.completion_rate ?? 1) <= (pipeline.sanction_rate ?? 1)
    ? { pct: fmtPct(pipeline.completion_rate), what: 'of sanctioned works are completed' }
    : { pct: fmtPct(pipeline.sanction_rate), what: 'of recommended works are sanctioned' }
  const mostFlagged = pipeline.stages.filter((s) => s.works > 0)
    .reduce((a, b) => (b.flagged / b.works > (a ? a.flagged / a.works : -1) ? b : a), null)

  // geometry (viewBox units; the SVG scales to the card's width). Both axes
  // share the same four gridlines: works on the left, flagged % on the right.
  const W = 600, H = 316
  const pad = { top: 29, right: 58, bottom: 60, left: 62 }
  const plotW = W - pad.left - pad.right, plotH = H - pad.top - pad.bottom
  const base = pad.top + plotH
  const worksStep = Math.max(1, niceStep(Math.max(...rows.map((r) => r.works), 1)))
  const shareStep = niceStep(Math.max(...rows.map((r) => (r.share ?? 0) * 100), 10))
  const yWorks = (v) => base - (v / (worksStep * 4)) * plotH
  const yShare = (p) => base - ((p * 100) / (shareStep * 4)) * plotH
  const slotW = plotW / rows.length
  const barW = Math.min(62, slotW * 0.52)

  const marks = rows.map((r, i) => {
    const cx = pad.left + (i + 0.5) * slotW
    const top = yWorks(r.works)
    const h = Math.max(base - top, r.works > 0 ? 2 : 0) // 2px floor: a real non-zero count never vanishes
    const py = r.share == null ? null : yShare(r.share)
    // the count sits inside the bar's foot when it fits and the line's point
    // isn't there; otherwise just above the bar
    const inside = h >= 31 && (py == null || py < base - 41)
    const countY = inside ? base - 11 : base - h - 7
    // the % label rides above its point, nudged clear of the count
    let pctY = py == null ? null : py - 12
    if (pctY != null && Math.abs(pctY - countY) < 16) pctY = Math.min(pctY, countY) - 16
    return { ...r, cx, h, py, inside, countY, pctY }
  })
  const linePts = marks.filter((m) => m.py != null).map((m) => `${m.cx},${m.py}`).join(' ')
  const hv = hover == null ? null : marks[hover]

  return (
    <div className="chart-card">
      <h3>{t(title)}</h3>
      <div className="tag-chart-sub">
        <span>{t('Works at each stage and the share flagged · {n} works', { n: total.toLocaleString('en-IN') })}</span>
        <span className="tag-legend">
          <span className="tag-legend-item"><span className="tag-legend-swatch" style={{ background: 'var(--lc-sanctioned)' }} />{t('No. of works')}</span>
          <span className="tag-legend-item">
            <svg className="pc-line-swatch" viewBox="0 0 18 10" aria-hidden="true">
              <line x1="0" x2="18" y1="5" y2="5" stroke={LINE} strokeWidth="2" />
              <circle cx="9" cy="5" r="3.5" fill={LINE} stroke="var(--surface)" strokeWidth="1.5" />
            </svg>
            {t('Flagged share (%)')}
          </span>
        </span>
      </div>
      <p className="chart-insight">
        {t('Biggest drop-off: only {pct} {what}.', { pct: worstStep.pct, what: t(worstStep.what) })}
        {mostFlagged && ' ' + t('{stage} has the highest flagged share ({pct}).', {
          stage: t(STAGES.find((s) => s.key === mostFlagged.key).label), pct: fmtPct(mostFlagged.flagged / mostFlagged.works),
        })}
      </p>

      <div className="pc-chart" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="lc-svg" role="img" aria-label={t(title)}>
          {[0, 1, 2, 3, 4].map((k) => {
            const y = base - (k / 4) * plotH
            return (
              <g key={k}>
                <line x1={pad.left} x2={W - pad.right} y1={y} y2={y} className={k === 0 ? 'lc-axis' : 'lc-grid'} />
                <text x={pad.left - 8} y={y + 4} textAnchor="end" className="lc-tick">{short(worksStep * k)}</text>
                <text x={W - pad.right + 8} y={y + 4} className="lc-tick">{`${+(shareStep * k).toFixed(1)}%`}</text>
              </g>
            )
          })}
          <text transform={`translate(14 ${pad.top + plotH / 2}) rotate(-90)`} textAnchor="middle" className="pc-axis-title">{t('Number of works')}</text>
          <text transform={`translate(${W - 10} ${pad.top + plotH / 2}) rotate(90)`} textAnchor="middle" className="pc-axis-title">{t('Flagged share (%)')}</text>

          {marks.map((m, i) => (
            <g key={m.key} className={`lc-group${hover === i ? ' active' : ''}`} onMouseEnter={() => setHover(i)}>
              {/* whole-column hit area, bigger than the bar */}
              <rect x={pad.left + i * slotW} y={pad.top} width={slotW} height={plotH} className="lc-hit" />
              {m.h > 0 && <path d={barPath(m.cx - barW / 2, base - m.h, barW, m.h)} fill={m.color} />}
              <text x={m.cx} y={m.countY} textAnchor="middle" className={`lc-value${m.inside && m.rollup ? ' pc-on-dark' : ''}`}>
                {m.works.toLocaleString('en-IN')}
              </text>
              <text x={m.cx} y={base + 19} textAnchor="middle" className="lc-xlabel">{t(m.label)}</text>
              <text x={m.cx} y={base + 36} textAnchor="middle" className="lc-tick">
                {twoLines(t(m.hint)).map((line, k) => <tspan key={k} x={m.cx} dy={k ? 15 : 0}>{line}</tspan>)}
              </text>
            </g>
          ))}

          <polyline points={linePts} fill="none" stroke={LINE} strokeWidth="2" strokeLinejoin="round" pointerEvents="none" />
          {marks.filter((m) => m.py != null).map((m) => (
            <g key={m.key} pointerEvents="none">
              <circle cx={m.cx} cy={m.py} r="4.5" fill={LINE} stroke="var(--surface)" strokeWidth="2" />
              <text x={m.cx} y={m.pctY} textAnchor="middle" className="lc-value pc-pct">{fmtPct(m.share)}</text>
            </g>
          ))}
        </svg>

        {hv && (
          <div className="lifecycle-tooltip" style={{ left: `${(hv.cx / W) * 100}%`, top: `${Math.max((Math.min(base - hv.h, hv.py ?? base) / H) * 100 - 4, 4)}%` }}>
            <div className="tooltip-sector">{t(hv.label)} <span className="pc-tip-hint">({t(hv.hint)})</span></div>
            <div className="tooltip-row">
              <span className="tooltip-swatch" style={{ background: hv.color }} />
              <strong className="tooltip-num">{hv.works.toLocaleString('en-IN')} {t('works')}</strong>
              <span className="tooltip-metric">· {t('{pct} of all works', { pct: fmtPct(total ? hv.works / total : null) })}</span>
            </div>
            <div className="tooltip-row">
              <span className="tooltip-swatch" style={{ background: LINE }} />
              <strong className="tooltip-num">{t('{n} flagged ({pct})', { n: hv.flagged.toLocaleString('en-IN'), pct: fmtPct(hv.share) })}</strong>
            </div>
            {rates[hv.key] && (
              <div className="tooltip-row">
                <span className="tooltip-metric">{fmtPct(rates[hv.key].rate)} {t(rates[hv.key].text)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      <table className="sr-only">
        <caption>{t(title)}</caption>
        <thead><tr><th>{t('Stage')}</th><th>{t('Works')}</th><th>{t('Flagged')}</th><th>{t('Flagged share (%)')}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}><td>{t(r.label)} ({t(r.hint)})</td><td>{r.works}</td><td>{r.flagged}</td><td>{fmtPct(r.share)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="chart-footnote">{t('Reached sanction is in progress and completed together, so the bars add up to more than the total. The line is the share of each bar\'s works that are flagged.')}</p>
    </div>
  )
}
