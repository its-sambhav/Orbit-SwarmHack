import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, formatRupees, formatDate } from '../api'
import { MospiNav } from '../components/MospiNav'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const LEVEL_LABEL = { overview: 'Overview', india: 'India (map)', state: 'State', district: 'District' }

function fmtRange(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return 'All time'
  return `${dateFrom ? formatDate(dateFrom) : '—'} to ${dateTo ? formatDate(dateTo) : '—'}`
}

// a report's summary is whatever page generated it snapshotted (funnel or
// scorecard shape both show up here) - render the fields that are actually
// present rather than assuming one fixed shape.
function SummaryLine({ label, value, isAmount }) {
  if (value === undefined || value === null) return null
  return (
    <div className="comparison-row">
      <span>{label}</span>
      <span className="value num">{isAmount ? formatRupees(value) : typeof value === 'number' ? value.toLocaleString('en-IN') : value}</span>
    </div>
  )
}

function ReportCard({ report, onDelete }) {
  const s = report.summary || {}
  return (
    <div className="chart-card">
      <div className="report-card-top">
        <div>
          <h3 style={{ marginBottom: 2 }}>{report.title}</h3>
          <div className="queue-item-meta">
            {LEVEL_LABEL[report.level] || report.level} · {report.scope} · Generated {formatDate(report.created_at)}
          </div>
        </div>
        <button type="button" className="btn-link" onClick={() => onDelete(report.id)}>Delete</button>
      </div>
      <div className="comparison-row">
        <span>Date range covered</span>
        <span className="value num">{fmtRange(report.date_from, report.date_to)}</span>
      </div>
      <SummaryLine label="Total works" value={s.total_works ?? s.works_total} />
      <SummaryLine label="Works flagged" value={s.works_flagged} />
      <SummaryLine label="Recommended" value={s.recommended_amount ?? s.recommended} isAmount />
      <SummaryLine label="Sanctioned" value={s.sanctioned_amount ?? s.sanctioned} isAmount />
      <SummaryLine label="Completed" value={s.completed_amount ?? s.completed} isAmount />
      <SummaryLine label="Paid" value={s.paid} isAmount />
      <SummaryLine label="Completion rate" value={s.completion_rate != null ? `${s.completion_rate.toFixed(0)}%` : null} />
      <SummaryLine label="Breach rate" value={s.breach_rate != null ? `${(s.breach_rate <= 1 ? s.breach_rate * 100 : s.breach_rate).toFixed(0)}%` : null} />
    </div>
  )
}

export function ReportsView() {
  const navigate = useNavigate()
  const [reports, setReports] = useState(null)
  const [error, setError] = useState(null)

  function load() {
    api.reports().then((d) => setReports(d.items)).catch((e) => setError(e.message))
  }
  useEffect(load, [])

  async function handleDelete(id) {
    await api.deleteReport(id)
    setReports((rs) => rs.filter((r) => r.id !== id))
  }

  if (error) return <ErrorView message={error} onRetry={() => window.location.reload()} />

  return (
    <div className="mospi-page">
      <MospiNav
        subtitle="MoSPI · Reports"
        searchIndex={[]}
        drawerLinks={[
          { label: 'Overview', onClick: () => navigate('/mospi') },
          { label: 'Map', onClick: () => navigate('/mospi/map') },
          { label: 'MP Audits', onClick: () => navigate('/mp-audits') },
          { label: 'Reports', onClick: () => navigate('/reports') },
        ]}
      />
      <div className="mospi-body">
        <h1 className="mospi-page-title">Reports</h1>
        <p className="mospi-page-sub">
          Snapshots generated from the Overview and Map pages - each one is frozen to the numbers and date range at the moment it was made.
        </p>

        {reports === null ? (
          <Loading label="Loading reports" />
        ) : reports.length ? (
          <div className="mospi-charts-grid">
            {reports.map((r) => <ReportCard key={r.id} report={r} onDelete={handleDelete} />)}
          </div>
        ) : (
          <EmptyState
            title="No reports generated yet"
            subtitle="Open the Overview page or the India/State/District map views, set a date range, and click Generate report."
          />
        )}
      </div>
    </div>
  )
}
