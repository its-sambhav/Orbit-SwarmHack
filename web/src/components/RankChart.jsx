// shared by every dashboard's "Works by pipeline stage" chart (and any other
// single-measure ranked bar list) - extracted out of NationalView.jsx so
// State/District/Agency/MP can reuse it instead of each keeping their own copy.
import { useLanguage } from '../i18n'

export function RankChart({ title, items, colorFor, onSelect, formatValue }) {
  const { t, td } = useLanguage()
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="chart-card">
      <h3>{t(title)}</h3>
      <div className="rank-list rank-list-compact">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className="rank-item"
            disabled={!onSelect}
            onClick={onSelect ? () => onSelect(item) : undefined}
            title={`${td(item.label)}: ${item.value.toLocaleString('en-IN')}`}
          >
            <span className="rank-item-name">{td(item.label)}</span>
            <span className="rank-item-meta num">{formatValue ? formatValue(item) : item.value.toLocaleString('en-IN')}</span>
            <span className="rank-item-bar">
              <span style={{ width: `${Math.max((item.value / max) * 100, 3)}%`, background: colorFor ? colorFor(item) : undefined }} />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
