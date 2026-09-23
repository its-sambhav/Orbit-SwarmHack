import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatDate, formatRupees } from '../api'
import { useLanguage } from '../i18n'
import { MospiNav } from '../components/MospiNav'
import { DateRangeFilter, GenerateReportButton } from '../components/ReportTools'
import { ScopeToggle } from '../components/ScopeToggle'
import { Loading, ErrorView, EmptyState } from '../components/StateViews'

const SCOPES = [{ value: '18th Lok Sabha', label: '18th Lok Sabha' }, { value: '17th Lok Sabha', label: '17th Lok Sabha' }]
const scopeLabel = (s) => (s === 'all' ? 'All scopes' : s)
const STAGE_LABEL = (w) => (w.has_completed ? 'Completed' : w.has_sanctioned ? 'Sanctioned' : 'Recommended')
// STAGE_LABEL's own three values, mapped onto the dotted stat.* keys the
// KPI cards already translate them with - reused here instead of adding a
// second, bare-English translation of the same three words.
const STAGE_KEY = { Recommended: 'stat.recommended', Sanctioned: 'stat.sanctioned', Completed: 'stat.completed' }
// the section tabs - "Flagged" is a different axis than the other three (a
// work's own review status, not its lifecycle stage) but reviewers think of
// it as one flat list of buckets, so it sits in the same row rather than a
// second control.
const SECTIONS = [
  { value: '', label: 'All Works' },
  { value: 'Recommended', label: STAGE_KEY.Recommended },
  { value: 'Sanctioned', label: STAGE_KEY.Sanctioned },
  { value: 'Completed', label: STAGE_KEY.Completed },
  { value: 'Flagged', label: 'Flagged' },
]

// The MP's own full works list - every work this MP has ever recommended
// (data.recommended_works, the same array MpMapView's side panel already
// shows a map-scoped slice of), not just the flagged ones AnomaliesView/the
// queue surfaces elsewhere. Its own page + side-menu entry, since a
// reviewer browsing the full portfolio has no real need for the map
// alongside it - same Overview/Map/Works 3-way split the app already uses
// for State (Overview/Map/Anomalies).
export function MpWorksView() {
  const { id: mpName } = useParams()
  const [params, setSearchParams] = useSearchParams()
  const scope = params.get('scope') || '18th Lok Sabha'
  const dateFrom = params.get('date_from') || null
  const dateTo = params.get('date_to') || null
  const navigate = useNavigate()
  const { t, td } = useLanguage()
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [districtFilter, setDistrictFilter] = useState('')
  const [sectionFilter, setSectionFilter] = useState('')

  useEffect(() => { api.meta().then(setMeta).catch(() => {}) }, [])

  useEffect(() => {
    setData(null)
    api.mp(mpName, scope, { dateFrom, dateTo }).then(setData).catch((e) => setError(e.message))
  }, [mpName, scope, dateFrom, dateTo])

  function setRange(from, to) {
    const next = new URLSearchParams(params)
    if (from) next.set('date_from', from); else next.delete('date_from')
    if (to) next.set('date_to', to); else next.delete('date_to')
    setSearchParams(next)
  }

  function setScope(next) {
    const p = new URLSearchParams(params)
    p.set('scope', next)
    setSearchParams(p)
  }

  const districts = useMemo(() => {
    if (!data) return []
    return [...new Set(data.recommended_works.map((w) => w.district).filter(Boolean))].sort()
  }, [data])

  const filteredWorks = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    return data.recommended_works.filter((w) => {
      if (districtFilter && w.district !== districtFilter) return false
      if (sectionFilter === 'Flagged') {
        if (!w.tags?.length) return false
      } else if (sectionFilter && STAGE_LABEL(w) !== sectionFilter) return false
      if (q) {
        const haystack = `${w.work_number} ${w.activity || ''} ${w.district || ''}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [data, search, districtFilter, sectionFilter])

  if (error) return <ErrorView message={error} />
  if (!data) return <Loading label="Loading works" />

  const overviewUrl = `/mp/${encodeURIComponent(mpName)}?${params.toString()}`
  const mapUrl = `/mp/${encodeURIComponent(mpName)}/map?${params.toString()}`

  return (
    <div className="mospi-page">
      <MospiNav
        scope={scope}
        subtitle={t('Member of Parliament · {mp} · Works', { mp: td(data.mp_name) })}
        searchIndex={[]}
        showSearch={false}
        profileName={data.mp_name}
        profileRole="Member of Parliament"
        avatarLetter="M"
        drawerLinks={[
          { label: 'Overview', onClick: () => navigate(overviewUrl) },
          { label: 'Map', onClick: () => navigate(mapUrl) },
          { label: 'Works', onClick: () => navigate(`/mp/${encodeURIComponent(mpName)}/works?${params.toString()}`) },
        ]}
      />
      <div className="mospi-body" id="report-capture">
        <div className="map-drill-header" style={{ marginBottom: 18 }}>
          <div className="mospi-header-row">
            <h1 style={{ margin: 0 }}>{t('{mp} — works', { mp: td(data.mp_name) })}</h1>
            <div className="report-toolbar">
              <ScopeToggle scopes={SCOPES} value={scope} onChange={setScope} />
              <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} bounds={{ min: meta?.date_min, max: meta?.date_max }} onChange={setRange} />
              <GenerateReportButton
                level="mp" scope={scope} dateFrom={dateFrom} dateTo={dateTo}
                title={`${data.mp_name} — ${scopeLabel(scope)}`} summary={data.scorecard}
              />
            </div>
          </div>
          <div className="mospi-header-meta">
            {td(data.constituency)}, {td(data.state)} · {t(scopeLabel(scope))} · {t(data.status)}
          </div>
        </div>

        <div className="panel">
          <div className="queue-panel-header">
            <h3>{t('Works ({n})', { n: filteredWorks.length })}</h3>
            <div className="queue-panel-header-controls">
              <div className="scope-toggle" role="tablist" aria-label="Works section">
                {SECTIONS.map((s) => (
                  <button
                    key={s.value} type="button" role="tab" aria-selected={sectionFilter === s.value}
                    className={`scope-toggle-btn${sectionFilter === s.value ? ' active' : ''}`}
                    onClick={() => setSectionFilter(s.value)}
                  >
                    {t(s.label)}
                  </button>
                ))}
              </div>
              <select className="queue-panel-header-select" value={districtFilter} onChange={(e) => setDistrictFilter(e.target.value)}>
                <option value="">{t('All districts')}</option>
                {districts.map((d) => <option key={d} value={d}>{td(d)}</option>)}
              </select>
              <input
                type="search" className="queue-search-input" placeholder={t('Search works…')} aria-label={t('Search works')}
                value={search} onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          {filteredWorks.length ? (
            <div className="queue-list queue-list-cards">
              {filteredWorks.map((w) => (
                <button
                  key={w.work_number}
                  className="queue-item"
                  onClick={() => navigate(`/work/${w.work_number}?scope_house=Lok%20Sabha&scope_tenure=${encodeURIComponent(scope)}&role=mp&role_name=${encodeURIComponent(data.mp_name)}&from=works`)}
                >
                  <div className="queue-item-top">
                    <span className="queue-item-title">{w.activity ? td(w.activity) : t('Work #{n}', { n: w.work_number })}</span>
                    <span className="queue-item-amount num">{formatRupees(w.recommended_amount)}</span>
                  </div>
                  <div className="queue-item-meta">
                    {[w.district && td(w.district), t(STAGE_KEY[STAGE_LABEL(w)]), t('Recommended {date}', { date: formatDate(w.recommended_date) })].filter(Boolean).join(' · ')}
                  </div>
                  {w.tags.length > 0 && (
                    <div className="queue-item-chips">
                      <span className="chip tag-chip">{t('Under review · {tags}', { tags: w.tags.map((tag) => t(tag)).join(', ') })}</span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <EmptyState title="No works match these filters" subtitle="Try clearing a filter or widening the date range." />
          )}
        </div>
      </div>
    </div>
  )
}
