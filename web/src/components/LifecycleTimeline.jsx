import { formatDate, formatRupees } from '../api'
import { useLanguage } from '../i18n'

function daysBetween(a, b) {
  if (!a || !b) return null
  return Math.round((new Date(b) - new Date(a)) / 86400000)
}

export function LifecycleTimeline({ lifecycle, horizontal = false }) {
  const { t, td } = useLanguage()
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
        ? t('{n} disbursements since {date}', {
            n: lifecycle.payment.disbursement_rows, date: formatDate(lifecycle.payment.first_date),
          })
        : null,
    },
  ]

  return (
    <ol className={`timeline${horizontal ? ' timeline-horizontal' : ''}`}>
      {stages.map((s, i) => {
        const prev = stages[i - 1]
        const gap = prev ? daysBetween(prev.date, s.date) : null
        const reached = !!s.date
        const days = gap === null ? null : Math.abs(gap).toLocaleString('en-IN')
        // the full sentence, kept as the hover/assistive text - on the rail the
        // "after {stage}" half is said by the line itself
        const gapFull = gap === null ? null : gap < 0
          ? t('recorded {days} days earlier than {stage} — data integrity flag',
              { days, stage: t(prev.label).toLowerCase() })
          : t('{days} days after {stage}', { days, stage: t(prev.label).toLowerCase() })

        return (
          <li key={s.key} className={`timeline-step${reached ? '' : ' timeline-step-pending'}`}>
            <div className="timeline-rail">
              {/* horizontal: an elapsed-time label rides the segment BETWEEN two
                  stages, which is what it actually measures - read as a sentence
                  inside the next stage it was easy to attach to the wrong one */}
              {horizontal && (
                <div className="timeline-connector timeline-connector-lead">
                  {days !== null && (
                    <span
                      className={`timeline-gap${gap < 0 ? ' timeline-gap-anomaly' : ''}`}
                      title={gapFull}
                    >
                      {gap < 0 ? t('{days} days earlier', { days }) : t('{days} days', { days })}
                    </span>
                  )}
                </div>
              )}
              <div className="timeline-node" />
              {horizontal
                ? <div className="timeline-connector timeline-connector-trail" />
                : i < stages.length - 1 && <div className="timeline-connector" />}
            </div>
            <div className="timeline-body">
              <div className="timeline-label">{t(s.label)}</div>
              <div className="timeline-date num">{reached ? formatDate(s.date) : t('Not yet reached')}</div>
              {s.amount != null && <div className="timeline-amount num">{formatRupees(s.amount)}</div>}
              {reached && s.authority && (
                <div className="timeline-authority">
                  <span className="timeline-authority-role">{t(s.role)}</span>
                  <span className="timeline-authority-name">{td(s.authority)}</span>
                </div>
              )}
              {reached && s.extra && <div className="timeline-authority">{s.extra}</div>}
              {/* the same elapsed time as the rail label, spelled out in full.
                  Only one of the two is ever shown (see .timeline-gap-note in
                  app.css): the rail carries it while the stages sit side by
                  side, this one takes over once they stack. */}
              {i > 0 && gap !== null && (
                <div className={`timeline-gap-note${gap < 0 ? ' timeline-gap-anomaly' : ''}`}>{gapFull}</div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
