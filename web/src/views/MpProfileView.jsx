import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatRupees, formatDate } from '../api'
import { MospiNav } from '../components/MospiNav'
import { ScorecardCell } from '../components/Scorecard'
import { Breadcrumb } from '../components/Breadcrumb'
import { SeverityChip, TagChip } from '../components/Chips'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'
import { MP_DRAWER_LINKS } from './MpAuditsView'
import { useLanguage } from '../i18n'

const STAGE_TAG = (w) => w.has_completed ? 'Completed' : w.has_sanctioned ? 'Sanctioned' : 'Recommended'

export function MpProfileView() {
  const { mpName } = useParams()
  const [params] = useSearchParams()
  const scope = params.get('scope') || '18th Lok Sabha'
  const navigate = useNavigate()
  const { t, td } = useLanguage()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setData(null)
    api.mp(mpName, scope).then(setData).catch((e) => setError(e.message))
  }, [mpName, scope])

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading MP profile" />

  const { scorecard } = data

  return (
    <div className="mospi-page">
      <MospiNav
        scope="18th Lok Sabha"
        subtitle={t('MoSPI · MP Audits')}
        searchIndex={[]}
        drawerLinks={MP_DRAWER_LINKS(navigate)}
      />

      <div className="mospi-map-page-body">
        <div className="mospi-map-page-header">
          <Breadcrumb items={[{ label: 'drawer.mpAudits', to: '/mp-audits' }, { label: data.mp_name }]} />
          <h1 className="mospi-page-title">{td(data.mp_name)}</h1>
          <p className="mospi-page-sub">{td(data.constituency)}, {td(data.state)} · {t(data.scope_tenure)} · {t(data.status)}</p>
        </div>

        <div className="map-drill-row map-drill-row-2col">
          <div className="map-drill-details">
            <h3>{t('MP scorecard')}</h3>
            <div className="scorecard-grid">
              <ScorecardCell label="Allocated" value={scorecard.allocated} />
              <ScorecardCell label="Recommended" value={scorecard.recommended} />
              <ScorecardCell label="Sanctioned" value={scorecard.sanctioned} />
              <ScorecardCell label="Completed" value={scorecard.completed} />
              <ScorecardCell label="Paid" value={scorecard.paid} />
              <div className="scorecard-cell">
                <div className="label">{t('Works flagged')}</div>
                <div className="value num">{scorecard.works_flagged.toLocaleString('en-IN')} / {scorecard.works_total.toLocaleString('en-IN')}</div>
              </div>
            </div>
            <div className="comparison-row">
              <span>{t('Completion rate')}</span>
              <span className="value num">{scorecard.completion_rate != null ? `${scorecard.completion_rate.toFixed(0)}%` : '—'}</span>
            </div>
            <div className="comparison-row">
              <span>{t('Breach rate')}</span>
              <span className="value num">{scorecard.breach_rate != null ? `${(scorecard.breach_rate * 100).toFixed(0)}%` : '—'}</span>
            </div>

            <h3>{t('Tenure')}</h3>
            <p className="fact-line">{formatDate(data.tenure_start)} – {formatDate(data.tenure_end)}</p>

            <h3>{t('Location')}</h3>
            <p className="fact-line">{td(data.constituency)}, {td(data.state)}</p>

            <h3>{t('Status')}</h3>
            <p className="fact-line">{t(data.status)}{data.status === 'Former' ? t(' — not on the 18th Lok Sabha roster') : ''}</p>
          </div>

          <div className="map-drill-center">
            <h3>{t('Works recommended ({n})', { n: data.recommended_works.length })}</h3>
            {data.recommended_works.length ? (
              <div className="queue-list">
                {data.recommended_works.map((w) => (
                  <button
                    key={w.work_number}
                    className="queue-item"
                    onClick={() => navigate(`/work/${w.work_number}?scope_house=Lok%20Sabha&scope_tenure=${encodeURIComponent(scope)}&from_mp=${encodeURIComponent(data.mp_name)}`)}
                  >
                    <div className="queue-item-top">
                      <span className="queue-item-title">{w.activity ? td(w.activity) : t('Work #{n}', { n: w.work_number })}</span>
                      <span className="queue-item-amount num">{formatRupees(w.recommended_amount)}</span>
                    </div>
                    <div className="queue-item-meta">
                      {w.district ? `${td(w.district)} · ` : ''}{w.stage ? t(w.stage) : '—'} · {t('Recommended {date}', { date: formatDate(w.recommended_date) })}
                    </div>
                    <div className="queue-item-chips">
                      {w.max_severity ? <SeverityChip severity={w.max_severity} /> : <TagChip tag={STAGE_TAG(w)} />}
                      {w.tags.map((tag) => <TagChip key={tag} tag={tag} />)}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState title="No works on record" subtitle="This MP has no recommendations logged for this scope." />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
