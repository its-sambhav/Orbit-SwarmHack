import { useEffect, useRef, useState } from 'react'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import { api, formatDate } from '../api'
import { useLanguage } from '../i18n'

const PRESETS = [
  { key: 'date.last3Months', label: 'Last 3 months', months: 3 },
  { key: 'date.last6Months', label: 'Last 6 months', months: 6 },
  { key: 'date.lastYear', label: 'Last year', months: 12 },
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
  const { t } = useLanguage()
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
  const label = !dateFrom && !dateTo ? t('date.allTime') : activePreset ? t(activePreset.key) : t('date.customRange')
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
                {t(p.key)}
              </button>
            ))}
            <button type="button" className="date-filter-preset-btn" onClick={() => { onChange(null, null); setOpen(false) }}>
              {t('date.allTime')}
            </button>
          </div>
          <div className="date-filter-custom">
            <label>
              {t('date.from')}
              <input
                type="date" value={dateFrom || ''} min={bounds?.min} max={bounds?.max}
                onChange={(e) => onChange(e.target.value || null, dateTo)}
              />
            </label>
            <label>
              {t('date.to')}
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

const REPORT_LABEL_KEY = { idle: 'report.generate', saving: 'report.generating', done: 'report.done', failed: 'report.failed' }

function sanitizeFilename(title) {
  return title.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'report'
}

function arrayBufferToBase64(buffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  return btoa(binary)
}

// renders #report-capture (the view's own content, everything below its
// .report-toolbar) into a paginated PDF - a real visual snapshot of what was
// on screen, not just the numbers. The toolbar itself (scope/date/this
// button) is excluded from the image since its own transient state
// ("Generating…") shouldn't end up baked into the picture; the applied
// scope/date range is printed as text in the header instead so nothing about
// what was filtered is lost.
async function captureReportPdf({ title, scope, dateFrom, dateTo, t }) {
  const node = document.getElementById('report-capture')
  if (!node) return null

  // the map card (.map-drill-map) is a grid sibling of the panels below with
  // no height of its own - it normally stretches to match the row. Measure
  // its height before anything is expanded, so it can be pinned there
  // afterward instead of stretching into a tall blank card once its
  // siblings grow to their full, unscrolled content height.
  const mapPanels = Array.from(node.querySelectorAll('.map-drill-map'))
  const mapHeights = mapPanels.map((el) => el.getBoundingClientRect().height)

  // the drill-down layout's side panels (.map-drill-details/-findings/
  // -center, see app.css) scroll independently inside a fixed-height row -
  // html2canvas only paints what's on screen, so a report would silently
  // cut off anything scrolled out of view. Expand them to their full content
  // height for the capture (the same overflow:visible app.css already
  // applies at narrow viewports for the stacked layout), then restore.
  const scrollPanels = node.querySelectorAll('.map-drill-details, .map-drill-findings, .map-drill-center')
  const restorePanels = Array.from(scrollPanels).map((el) => {
    const prev = el.style.cssText
    el.style.overflow = 'visible'
    el.style.maxHeight = 'none'
    el.style.alignSelf = 'start'
    return () => { el.style.cssText = prev }
  })
  const restoreMaps = mapPanels.map((el, i) => {
    const prev = el.style.cssText
    el.style.height = `${mapHeights[i]}px`
    el.style.alignSelf = 'start'
    return () => { el.style.cssText = prev }
  })

  // .mospi-map-page-body (the capture root on drill-down views) is
  // position:fixed pinned to the viewport, so its own clientHeight stays
  // viewport-sized even once the panels above are expanded - only
  // scrollHeight reflects the real, now-full content height. Passing that
  // through as windowHeight makes html2canvas re-lay-out against a taller
  // virtual viewport, so fixed/vh-based sizing resolves against the full
  // content instead of clipping to the screen.
  const fullHeight = node.scrollHeight

  let canvas
  try {
    canvas = await html2canvas(node, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      height: fullHeight,
      windowHeight: fullHeight,
      ignoreElements: (el) => el.classList?.contains('report-toolbar'),
    })
  } finally {
    restorePanels.forEach((fn) => fn())
    restoreMaps.forEach((fn) => fn())
  }

  const pdf = new jsPDF({ orientation: 'p', unit: 'pt', format: 'a4' })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 32
  const imgWidth = pageWidth - margin * 2

  // titles are entity names (agency names especially run long) - wrap
  // rather than let jsPDF clip a fixed one-line title at the page edge.
  let y = margin
  pdf.setFontSize(14)
  const titleLines = pdf.splitTextToSize(title, imgWidth)
  pdf.text(titleLines, margin, y)
  y += titleLines.length * 17

  pdf.setFontSize(10)
  pdf.setTextColor(90)
  const rangeText = !dateFrom && !dateTo
    ? t('All time')
    : t('{from} to {to}', { from: dateFrom ? formatDate(dateFrom) : '—', to: dateTo ? formatDate(dateTo) : '—' })
  pdf.text(`${scope} · ${rangeText}`, margin, y)
  y += 14
  pdf.text(t('Generated {date}', { date: formatDate(new Date().toISOString()) }), margin, y)
  pdf.setTextColor(0)

  // slice the (possibly very tall) captured canvas into page-height chunks,
  // scaled to fit the PDF's content width, one addImage per page.
  const contentTop = y + 16
  const ratio = imgWidth / canvas.width
  const pxPerPage = Math.floor((pageHeight - contentTop - margin) / ratio)
  const slice = document.createElement('canvas')
  slice.width = canvas.width
  const ctx = slice.getContext('2d')

  let renderedPx = 0
  let firstPage = true
  while (renderedPx < canvas.height) {
    const sliceHeight = Math.min(pxPerPage, canvas.height - renderedPx)
    slice.height = sliceHeight
    ctx.clearRect(0, 0, slice.width, sliceHeight)
    ctx.drawImage(canvas, 0, renderedPx, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight)
    if (!firstPage) pdf.addPage()
    // JPEG, not PNG - this is a photo-like raster of gradients/anti-aliased
    // text at 2x scale, where lossless PNG runs 10-20x larger for no visible
    // gain in a report meant to be read, not pixel-inspected.
    pdf.addImage(slice.toDataURL('image/jpeg', 0.85), 'JPEG', margin, firstPage ? contentTop : margin, imgWidth, sliceHeight * ratio)
    renderedPx += sliceHeight
    firstPage = false
  }

  return pdf
}

// snapshots the current page (level/entity/scope/date-range + its headline
// numbers, plus a visual PDF of the screen) into a saved report, listed on
// the Reports page - a frozen record of what was on screen at generation
// time, not a live link.
export function GenerateReportButton({ level, title, scope, dateFrom, dateTo, state, district, agency, summary }) {
  const { t } = useLanguage()
  const [status, setStatus] = useState('idle')

  async function generate() {
    setStatus('saving')
    try {
      const pdf = await captureReportPdf({ title, scope, dateFrom, dateTo, t })
      const pdfBase64 = pdf ? arrayBufferToBase64(pdf.output('arraybuffer')) : null
      await api.createReport({
        level, title, scope, date_from: dateFrom, date_to: dateTo,
        state: state || null, district: district || null, agency: agency || null,
        summary, pdf_base64: pdfBase64,
      })
      if (pdf) pdf.save(`${sanitizeFilename(title)}_${new Date().toISOString().slice(0, 10)}.pdf`)
      setStatus('done')
    } catch {
      setStatus('failed')
    } finally {
      setTimeout(() => setStatus('idle'), 2500)
    }
  }

  return (
    <button type="button" className="generate-report-btn" onClick={generate} disabled={status === 'saving' || !summary}>
      {t(REPORT_LABEL_KEY[status])}
    </button>
  )
}
