import { formatDate, formatRupees } from '../api'

function daysBetween(a, b) {
  if (!a || !b) return null
  return Math.round((new Date(b) - new Date(a)) / 86400000)
}

export function LifecycleTimeline({ lifecycle }) {
  const stages = [
    {
      key: 'recommended', label: 'Recommended', date: lifecycle.recommended.date, amount: lifecycle.recommended.amount,
      authority: lifecycle.recommended.authority, role: lifecycle.recommended.authority_role,
    },
    {
      key: 'sanctioned', label: 'Sanctioned', date: lifecycle.sanctioned.date, amount: lifecycle.sanctioned.amount,
      authority: lifecycle.sanctioned.authority, role: lifecycle.sanctioned.authority_role,
    },
    {
      key: 'completed', label: 'Completed', date: lifecycle.completed.date, amount: lifecycle.completed.amount,
      authority: lifecycle.completed.authority, role: lifecycle.completed.authority_role,
    },
    {
      key: 'payment', label: 'Last payment', date: lifecycle.payment.last_date, amount: lifecycle.payment.total_disbursed,
      authority: lifecycle.payment.authority, role: lifecycle.payment.authority_role,
      extra: lifecycle.payment.disbursement_rows > 1
        ? `${lifecycle.payment.disbursement_rows} disbursements since ${formatDate(lifecycle.payment.first_date)}`
        : null,
    },
  ]

  return (
    <ol className="timeline">
      {stages.map((s, i) => {
        const prev = stages[i - 1]
        const gap = prev ? daysBetween(prev.date, s.date) : null
        const reached = !!s.date
        return (
          <li key={s.key} className={`timeline-step${reached ? '' : ' timeline-step-pending'}`}>
            <div className="timeline-rail">
              <div className="timeline-node" />
              {i < stages.length - 1 && <div className="timeline-connector" />}
            </div>
            <div className="timeline-body">
              <div className="timeline-label">{s.label}</div>
              <div className="timeline-date num">{reached ? formatDate(s.date) : 'Not yet reached'}</div>
              {s.amount != null && <div className="timeline-amount num">{formatRupees(s.amount)}</div>}
              {reached && s.authority && (
                <div className="timeline-authority"><span className="timeline-authority-role">{s.role}</span> {s.authority}</div>
              )}
              {reached && s.extra && <div className="timeline-authority">{s.extra}</div>}
              {i > 0 && gap !== null && (
                <div className={`timeline-gap-note${gap < 0 ? ' timeline-gap-anomaly' : ''}`}>
                  {gap < 0
                    ? `recorded ${Math.abs(gap).toLocaleString('en-IN')} days earlier than ${prev.label.toLowerCase()} — data integrity flag`
                    : `${gap.toLocaleString('en-IN')} days after ${prev.label.toLowerCase()}`}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
