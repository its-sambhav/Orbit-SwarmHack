import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

const PRESETS = [
  { label: 'Last 3 months', months: 3 },
  { label: 'Last 6 months', months: 6 },
  { label: 'Last year', months: 12 },
]

function fmtShort(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function fmtLong(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// calendar-month subtraction, not a fixed day count - "last 3 months" means
// the same date 3 months back, not a rounded 90/180/365-day guess.
function presetRange(months, maxIso) {
  const end = new Date(maxIso)
  const start = new Date(end)
  start.setMonth(start.getMonth() - months)
  start.setDate(start.getDate() + 1)
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }
}

// date-range control shared by Overview + Map's India/State/District views -
// narrows every number on the page to works recommended within the window
// (recommendation date is the one date field present on essentially every
// work - see docs/SCHEMA.md). Presets anchor to the dataset's own max date
// (bounds.max, the engine's frozen as_of_date) rather than the browser
// clock - this is a historical snapshot, not a live feed.
export function DateRangeFilter({ dateFrom, dateTo, bounds, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const activePreset = bounds?.max && dateFrom && dateTo
    ? PRESETS.find((p) => {
        const r = presetRange(p.months, bounds.max)
        return r.from === dateFrom && r.to === dateTo
      })
    : null
  const label = !dateFrom && !dateTo ? 'All time' : activePreset ? activePreset.label : 'Custom range'
  const rangeText = dateFrom && dateTo
    ? `${fmtShort(dateFrom)} – ${fmtLong(dateTo)}`
    : bounds?.min && bounds?.max ? `${fmtShort(bounds.min)} – ${fmtLong(bounds.max)}` : ''

  return (
    <div className="date-filter" ref={ref}>
      <button type="button" className="date-filter-btn" onClick={() => setOpen((o) => !o)}>
        <span className="date-filter-preset">{label}</span>
        {rangeText && <span className="date-filter-range">{rangeText}</span>}
        <span className="date-filter-caret">▾</span>
      </button>
      {open && (
        <div className="date-filter-pop">
          <div className="date-filter-presets">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="date-filter-preset-btn"
                onClick={() => {
                  const r = presetRange(p.months, bounds?.max || new Date().toISOString().slice(0, 10))
                  onChange(r.from, r.to)
                  setOpen(false)
                }}
              >
                {p.label}
              </button>
            ))}
            <button type="button" className="date-filter-preset-btn" onClick={() => { onChange(null, null); setOpen(false) }}>
              All time
            </button>
          </div>
          <div className="date-filter-custom">
            <label>
              From
              <input
                type="date" value={dateFrom || ''} min={bounds?.min} max={bounds?.max}
                onChange={(e) => onChange(e.target.value || null, dateTo)}
              />
            </label>
            <label>
              To
              <input
                type="date" value={dateTo || ''} min={bounds?.min} max={bounds?.max}
                onChange={(e) => onChange(dateFrom, e.target.value || null)}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

const REPORT_LABEL = { idle: 'Generate report', saving: 'Generating…', done: 'Report saved ✓', failed: 'Failed — retry' }

// snapshots the current page (level/entity/scope/date-range + its headline
// numbers) into a saved report, listed on the new Reports page - a frozen
// record of what the numbers said at generation time, not a live link.
export function GenerateReportButton({ level, title, scope, dateFrom, dateTo, state, district, summary }) {
  const [status, setStatus] = useState('idle')

  async function generate() {
    setStatus('saving')
    try {
      await api.createReport({
        level, title, scope, date_from: dateFrom, date_to: dateTo,
        state: state || null, district: district || null, summary,
      })
      setStatus('done')
    } catch {
      setStatus('failed')
    } finally {
      setTimeout(() => setStatus('idle'), 2500)
    }
  }

  return (
    <button type="button" className="generate-report-btn" onClick={generate} disabled={status === 'saving' || !summary}>
      {REPORT_LABEL[status]}
    </button>
  )
}
