import { useState, useMemo } from 'react'

/**
 * Metric color definitions adhering to the GovTech high-contrast palette:
 * - Recommended: #3B82F6 (Blue)
 * - Sanctioned: #F59E0B (Amber)
 * - High Risk Flagged: #EF4444 (Crimson Danger)
 * - Completed: #10B981 (Emerald Success)
 */
const METRICS = [
  { key: 'recommended', label: 'Recommended', color: '#3B82F6', crKey: 'recommended_cr' },
  { key: 'sanctioned', label: 'Sanctioned', color: '#F59E0B', crKey: 'sanctioned_cr' },
  { key: 'highRisk', label: 'High Risk Flagged', color: '#EF4444', crKey: 'highRisk_cr' },
  { key: 'completed', label: 'Completed', color: '#10B981', crKey: 'completed_cr' },
]

export function ProjectLifecycleBarChart({
  sectors = [],
  title = 'Project Lifecycle & Risk Breakdown',
}) {
  const [chartMode, setChartMode] = useState('grouped') // 'grouped' | 'stacked'
  const [hoveredBar, setHoveredBar] = useState(null) // { sector, metric, value, valueCr, x, y }

  // Compute maximum values for scaling
  const { maxGrouped, maxStacked } = useMemo(() => {
    let mg = 0
    let ms = 0
    sectors.forEach((s) => {
      METRICS.forEach((m) => {
        if ((s[m.key] || 0) > mg) mg = s[m.key] || 0
      })
      const stackedSum = (s.recommended || 0) + (s.sanctioned || 0) + (s.highRisk || 0) + (s.completed || 0)
      if (stackedSum > ms) ms = stackedSum
    })
    return {
      maxGrouped: Math.max(mg * 1.15, 10),
      maxStacked: Math.max(ms * 1.15, 10),
    }
  }, [sectors])

  // SVG dimensions
  const svgWidth = 560
  const svgHeight = 240
  const padding = { top: 20, right: 20, bottom: 45, left: 55 }
  const chartWidth = svgWidth - padding.left - padding.right
  const chartHeight = svgHeight - padding.top - padding.bottom

  const maxVal = chartMode === 'stacked' ? maxStacked : maxGrouped
  const groupWidth = chartWidth / (sectors.length || 1)
  const barWidth = chartMode === 'grouped' ? Math.min((groupWidth - 16) / 4, 22) : Math.min(groupWidth - 30, 48)

  // Grouped bars are independent, so a sqrt scale is safe here: it compresses
  // the dominant category (e.g. Infrastructure & Roads) and lifts the small
  // ones (e.g. Irrigation & Rural Dev) enough to stay visible next to it,
  // while sqrt(0) = 0 needs no special-casing the way a log scale would.
  // Stacked mode keeps a plain linear scale - a stack's whole point is that
  // segment heights add up to the total, which only holds under a linear
  // scale (sqrt(a) + sqrt(b) != sqrt(a + b), so a "sqrt-stacked" bar would
  // have no honest reading for its combined height).
  const toPixelSpace = chartMode === 'grouped' ? (v) => Math.sqrt(Math.max(v, 0)) : (v) => Math.max(v, 0)
  const maxPixelSpace = toPixelSpace(maxVal) || 1

  // Y-axis ticks - evenly spaced in the same (possibly sqrt) space the bars
  // use, then mapped back to a real value for the label, so gridlines stay
  // evenly spaced on screen even though the labelled values are not.
  const yTicks = useMemo(() => {
    const ticks = []
    const count = 4
    for (let i = 0; i <= count; i++) {
      const pixelSpaceVal = (maxPixelSpace / count) * i
      const val = Math.round(chartMode === 'grouped' ? pixelSpaceVal * pixelSpaceVal : pixelSpaceVal)
      const y = padding.top + chartHeight - (pixelSpaceVal / maxPixelSpace) * chartHeight
      ticks.push({ val, y })
    }
    return ticks
  }, [maxPixelSpace, chartMode, chartHeight, padding.top])

  function formatCount(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
    return n.toLocaleString('en-IN')
  }

  return (
    <div className="chart-card project-lifecycle-card">
      <div className="lifecycle-card-header">
        <div>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <span className="lifecycle-card-sub">
            Project volume & financial exposure across lifecycle phases
          </span>
        </div>
        <div className="lifecycle-mode-toggle">
          <button
            type="button"
            className={`mode-btn ${chartMode === 'grouped' ? 'active' : ''}`}
            onClick={() => setChartMode('grouped')}
          >
            Grouped
          </button>
          <button
            type="button"
            className={`mode-btn ${chartMode === 'stacked' ? 'active' : ''}`}
            onClick={() => setChartMode('stacked')}
          >
            Stacked
          </button>
        </div>
      </div>

      {/* Interactive Legend */}
      <div className="lifecycle-legend">
        {METRICS.map((m) => {
          const totalVal = sectors.reduce((acc, s) => acc + (s[m.key] || 0), 0)
          const totalCr = sectors.reduce((acc, s) => acc + (s[m.crKey] || 0), 0)
          return (
            <div key={m.key} className="lifecycle-legend-item">
              <span className="legend-dot" style={{ background: m.color }} />
              <span className="legend-label">{m.label}</span>
              <span className="legend-val num">{totalVal.toLocaleString('en-IN')}</span>
              <span className="legend-cr num">(₹{totalCr.toFixed(1)} Cr)</span>
            </div>
          )
        })}
      </div>

      {/* Responsive SVG Chart Container */}
      <div className="lifecycle-svg-wrap">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="lifecycle-svg"
          preserveAspectRatio="xMidYMid meet"
          onMouseLeave={() => setHoveredBar(null)}
        >
          {/* Names the non-linear axis where the reader actually reads heights,
              rather than in the card subtitle - which wraps to several lines in
              the narrow sidebar the state/district/agency pages render this in. */}
          {chartMode === 'grouped' && (
            <text x={2} y={12} fontSize="9" fill="#94a3b8" fontWeight="600">
              √ scale
            </text>
          )}

          {/* Y-Axis Grid Lines & Labels */}
          {yTicks.map((t, idx) => (
            <g key={idx}>
              <line
                x1={padding.left}
                y1={t.y}
                x2={svgWidth - padding.right}
                y2={t.y}
                stroke="#e2e8f0"
                strokeDasharray={idx === 0 ? 'none' : '3 3'}
                strokeWidth={idx === 0 ? '1.5' : '1'}
              />
              <text
                x={padding.left - 8}
                y={t.y + 4}
                textAnchor="end"
                fontSize="10"
                fill="#64748b"
                fontWeight="500"
              >
                {formatCount(t.val)}
              </text>
            </g>
          ))}

          {/* Sector Bars */}
          {sectors.map((s, sIdx) => {
            const groupX = padding.left + sIdx * groupWidth + (groupWidth - (chartMode === 'grouped' ? barWidth * 4 : barWidth)) / 2
            let currentStackY = padding.top + chartHeight

            return (
              <g key={s.sector}>
                {METRICS.map((m, mIdx) => {
                  const val = s[m.key] || 0
                  const valCr = s[m.crKey] || 0
                  const barH = (toPixelSpace(val) / maxPixelSpace) * chartHeight

                  let barX = 0
                  let barY = 0

                  if (chartMode === 'grouped') {
                    barX = groupX + mIdx * barWidth
                    barY = padding.top + chartHeight - barH
                  } else {
                    barX = groupX
                    currentStackY -= barH
                    barY = currentStackY
                  }

                  const isHovered =
                    hoveredBar?.sector === s.sector && hoveredBar?.metric === m.key

                  return (
                    <rect
                      key={m.key}
                      x={barX}
                      y={barY}
                      width={Math.max(barWidth - (chartMode === 'grouped' ? 3 : 0), 2)}
                      height={Math.max(barH, 0)}
                      rx={chartMode === 'grouped' || mIdx === METRICS.length - 1 ? 3 : 0}
                      fill={m.color}
                      opacity={isHovered ? 1 : 0.88}
                      className="lifecycle-bar"
                      style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
                      onMouseEnter={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        setHoveredBar({
                          sector: s.sector,
                          metricLabel: m.label,
                          metric: m.key,
                          color: m.color,
                          value: val,
                          valueCr: valCr,
                          x: barX + barWidth / 2,
                          y: barY,
                        })
                      }}
                    />
                  )
                })}

                {/* X-Axis Sector Label */}
                <text
                  x={padding.left + (sIdx + 0.5) * groupWidth}
                  y={svgHeight - 12}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#475569"
                  fontWeight="600"
                  className="sector-label"
                >
                  {s.sector.length > 16 ? `${s.sector.substring(0, 14)}…` : s.sector}
                </text>
              </g>
            )
          })}
        </svg>

        {/* Floating Tooltip */}
        {hoveredBar && (
          <div
            className="lifecycle-tooltip"
            style={{
              left: `${(hoveredBar.x / svgWidth) * 100}%`,
              top: `${Math.max((hoveredBar.y / svgHeight) * 100 - 18, 5)}%`,
            }}
          >
            <div className="tooltip-sector">{hoveredBar.sector}</div>
            <div className="tooltip-row">
              <span className="tooltip-swatch" style={{ background: hoveredBar.color }} />
              <span className="tooltip-metric">{hoveredBar.metricLabel}:</span>
              <strong className="tooltip-num">{hoveredBar.value.toLocaleString('en-IN')} works</strong>
            </div>
            <div className="tooltip-financial">
              Financial exposure: <strong>₹{hoveredBar.valueCr.toFixed(1)} Cr</strong>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
