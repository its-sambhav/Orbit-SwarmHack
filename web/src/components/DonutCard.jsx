// shared by every dashboard's "Findings by tag" donut - extracted out of
// NationalView.jsx so State/District/Agency/MP can reuse it. Part-of-whole
// distributions read better as a donut than a bar rank - built on a CSS
// conic-gradient rather than pulling in a chart library for this one chart.
import { useLanguage } from '../i18n'

export function DonutCard({ title, items, colorFor, onSelect }) {
  const { t, td } = useLanguage()
  const total = items.reduce((s, i) => s + i.value, 0)
  let acc = 0
  const stops = items.map((item) => {
    const from = total ? (acc / total) * 360 : 0
    acc += item.value
    const to = total ? (acc / total) * 360 : 0
    return `${colorFor(item)} ${from}deg ${to}deg`
  }).join(', ')
  return (
    <div className="chart-card">
      <h3>{t(title)}</h3>
      <div className="donut-row">
        <div className="donut-chart" style={{ background: total ? `conic-gradient(${stops})` : 'var(--surface-sunken)' }}>
          <div className="donut-hole">
            <span className="donut-hole-value num">{total.toLocaleString('en-IN')}</span>
            <span className="donut-hole-label">{t('total')}</span>
          </div>
        </div>
        <div className="donut-legend">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              className="donut-legend-row"
              disabled={!onSelect}
              onClick={onSelect ? () => onSelect(item) : undefined}
            >
              <span className="donut-legend-swatch" style={{ background: colorFor(item) }} />
              <span className="donut-legend-label">{td(item.label)}</span>
              <span className="donut-legend-value num">{item.value.toLocaleString('en-IN')}</span>
              <span className="donut-legend-pct num">{total ? `${((item.value / total) * 100).toFixed(0)}%` : '—'}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
