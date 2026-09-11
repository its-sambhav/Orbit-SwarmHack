// pure-CSS conic-gradient donut + clickable legend - same shape as the one
// built inline in NationalView.jsx, extracted so a second dashboard (MP's
// development-category chart) can use it without duplicating the markup.
// segments carry their own color (not a colorFor() callback) since callers
// here don't share NationalView's fixed severity/tag palettes. `compact`
// stacks the chart above a narrower legend (label + % only, no raw count)
// instead of side-by-side - NationalView's own donut lives in a roomy
// half-page card and doesn't need this; a dashboard's narrower detail
// column does, or long real category names (unlike NationalView's short
// fixed tag vocabulary) truncate to almost nothing.
export function DonutChart({ title, segments, onSelect, compact = false }) {
  const total = segments.reduce((s, i) => s + i.value, 0)
  let acc = 0
  const stops = segments.map((seg) => {
    const from = total ? (acc / total) * 360 : 0
    acc += seg.value
    const to = total ? (acc / total) * 360 : 0
    return `${seg.color} ${from}deg ${to}deg`
  }).join(', ')

  return (
    <div className="chart-card">
      {title && <h3>{title}</h3>}
      <div className={compact ? 'donut-row donut-row-stacked' : 'donut-row'}>
        <div className="donut-chart" style={{ background: total ? `conic-gradient(${stops})` : 'var(--surface-sunken)' }}>
          <div className="donut-hole">
            <span className="donut-hole-value num">{total.toLocaleString('en-IN')}</span>
            <span className="donut-hole-label">total</span>
          </div>
        </div>
        <div className="donut-legend">
          {segments.map((seg) => (
            <button
              key={seg.label}
              type="button"
              className={compact ? 'donut-legend-row donut-legend-row-compact' : 'donut-legend-row'}
              disabled={!onSelect}
              onClick={onSelect ? () => onSelect(seg) : undefined}
            >
              <span className="donut-legend-swatch" style={{ background: seg.color }} />
              <span className="donut-legend-label" title={seg.label}>{seg.label}</span>
              {!compact && <span className="donut-legend-value num">{seg.value.toLocaleString('en-IN')}</span>}
              <span className="donut-legend-pct num">{total ? `${((seg.value / total) * 100).toFixed(0)}%` : '—'}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// a fixed, order-stable hue rotation for an arbitrary-length category list
// (development activities differ per MP) - not a validated categorical
// palette like tokens.css's 3-tag set, so kept to muted/desaturated tones
// that stay legible without claiming CVD-safety it hasn't been checked for.
const PALETTE = ['#1F3D5C', '#93721F', '#3A6BA8', '#2E7A3D', '#B85A82', '#7A5E19', '#4B5348', '#A73E3E', '#16304A', '#767F73']
export function colorForIndex(i) {
  return PALETTE[i % PALETTE.length]
}
