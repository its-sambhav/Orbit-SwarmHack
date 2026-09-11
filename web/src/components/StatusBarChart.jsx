import { formatRupees } from '../api'

// 4 distinct pipeline/risk states, each its own hue rather than one shared
// accent (Funnel.jsx's decreasing-magnitude funnel bars intentionally stay
// one colour; this is a status comparison, not a funnel) - validated
// together via the dataviz skill's palette checker (scripts/validate_palette.js)
// against this app's own surface and its existing --sev-high red (kept
// fixed since that token is reserved for severity everywhere else in the
// app): all 4 hard gates pass in this order, worst adjacent CVD Delta E 15.1.
// Amber/aqua sit under the 3:1 contrast floor against a white card, which is
// fine here only because every bar is always direct-labelled (name + count
// + a legend swatch) - color never has to carry the identification alone.
export const STATUS_COLORS = { recommended: '#2a78d6', sanctioned: '#eda100', highRisk: 'var(--sev-high)', completed: '#1baf7a' }

// shared across every scope level (national/state/district/constituency/
// agency) - each page builds its own `items` from its own scorecard, since
// which categories apply differs (e.g. an agency has no "recommended").
export function StatusBarChart({ title, items }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <div className="status-bar-chart">
        {items.map((item) => (
          <div className="status-bar-col" key={item.label}>
            <div className="status-bar-value num">{item.value.toLocaleString('en-IN')}</div>
            <div className="status-bar-track">
              <div
                className="status-bar-fill"
                style={{ height: `${Math.max((item.value / max) * 100, 2)}%`, background: item.color }}
                title={`${item.label}: ${item.value.toLocaleString('en-IN')} works · ${formatRupees(item.amount)}`}
              />
            </div>
            <div className="status-bar-label">{item.label}</div>
          </div>
        ))}
      </div>
      <div className="status-bar-legend">
        {items.map((item) => (
          <span className="status-bar-legend-item" key={item.label}>
            <span className="status-bar-swatch" style={{ background: item.color }} />
            {item.label} · {formatRupees(item.amount)}
          </span>
        ))}
      </div>
    </div>
  )
}
