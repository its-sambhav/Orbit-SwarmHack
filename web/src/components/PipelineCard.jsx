import { useLanguage } from '../i18n'

const STAGES = {
  awaiting_sanction: { label: 'Awaiting sanction', hint: 'recommended, not yet sanctioned' },
  in_progress: { label: 'In progress', hint: 'sanctioned, not yet completed' },
  completed: { label: 'Completed', hint: 'marked complete' },
}
const fmtPct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)

/**
 * Where works are right now, as a single-column funnel. Each level shows how
 * many works got AT LEAST that far (all works -> reached sanction ->
 * completed): a centred caption, then a centred bar whose width is that
 * count's share of all works, so the bars narrow as works drop out. Under
 * each bar, one line for the works stuck at that stage right now (each work
 * counted once, so these add up to the total) with how many of them are
 * flagged. Between levels, the share that made it through.
 *
 * Everything is stacked in one column and every line is allowed to wrap, so
 * nothing can overlap or be cut off however narrow the card gets.
 *
 * pipeline: { total, stages: [{ key, works, flagged }], sanction_rate, completion_rate }
 * (api/main.py pipeline_summary)
 */
export function PipelineCard({ pipeline, title = 'Where works are in the pipeline' }) {
  const { t } = useLanguage()
  if (!pipeline) return null
  const total = pipeline.total || 0
  const byKey = Object.fromEntries(pipeline.stages.map((s) => [s.key, s]))
  const none = { works: 0, flagged: 0 }
  const awaiting = byKey.awaiting_sanction || none
  const inProgress = byKey.in_progress || none
  const completed = byKey.completed || none

  // funnel levels: how many works reached at least this far
  const levels = [
    { key: 'awaiting_sanction', label: 'All works', reached: total, color: 'var(--lc-recommended)', stage: awaiting },
    { key: 'in_progress', label: 'Reached sanction', reached: inProgress.works + completed.works, color: 'var(--lc-sanctioned)', stage: inProgress },
    { key: 'completed', label: 'Completed', reached: completed.works, color: 'var(--lc-completed)', stage: completed },
  ]
  const arrows = [
    { rate: pipeline.sanction_rate, text: 'of recommended works were sanctioned' },
    { rate: pipeline.completion_rate, text: 'of sanctioned works were completed' },
  ]

  const worstStep = (pipeline.completion_rate ?? 1) <= (pipeline.sanction_rate ?? 1)
    ? { pct: fmtPct(pipeline.completion_rate), what: 'of sanctioned works are completed' }
    : { pct: fmtPct(pipeline.sanction_rate), what: 'of recommended works are sanctioned' }
  const mostFlagged = pipeline.stages.filter((s) => s.works > 0)
    .reduce((a, b) => (b.flagged / b.works > (a ? a.flagged / a.works : -1) ? b : a), null)

  return (
    <div className="chart-card">
      <h3>{t(title)}</h3>
      <div className="tag-chart-sub">
        <span>{t('Each work counted once, at its current stage · {n} works', { n: total.toLocaleString('en-IN') })}</span>
        <span className="tag-legend">
          <span className="tag-legend-item"><span className="tag-legend-swatch" style={{ background: 'var(--accent)' }} />{t('Flagged share of the stage')}</span>
        </span>
      </div>
      <p className="chart-insight">
        {t('Biggest drop-off: only {pct} {what}.', { pct: worstStep.pct, what: t(worstStep.what) })}
        {mostFlagged && ' ' + t('{stage} has the highest flagged share ({pct}).', {
          stage: t(STAGES[mostFlagged.key].label), pct: fmtPct(mostFlagged.flagged / mostFlagged.works),
        })}
      </p>

      <div className="pf">
        {levels.map((lv, i) => {
          const width = total ? Math.max((lv.reached / total) * 100, 4) : 4
          const st = lv.stage
          const meta = STAGES[lv.key]
          const flaggedShare = st.works ? st.flagged / st.works : null
          return (
            <div key={lv.key} className="pf-level">
              <div className="pf-caption">
                <span className="pf-caption-label">{t(lv.label)}</span>
                <span className="pf-caption-value num">{lv.reached.toLocaleString('en-IN')}</span>
                <span className="pf-caption-share num">{fmtPct(total ? lv.reached / total : null)}</span>
              </div>
              <div className="pf-bar" style={{ width: `${width}%`, background: lv.color }} aria-hidden="true" />
              <div className="pf-stage-line" role="group" aria-label={t('{stage}: {works} works, {flagged} flagged', {
                stage: t(meta.label), works: st.works.toLocaleString('en-IN'), flagged: st.flagged.toLocaleString('en-IN'),
              })}>
                <span className="pf-stage-name">
                  {t(meta.label)} <span className="pf-stage-hint">({t(meta.hint)})</span>
                </span>
                <span className="pf-stage-count num">
                  {st.works.toLocaleString('en-IN')} <span className="pf-stage-share">{fmtPct(total ? st.works / total : null)}</span>
                </span>
                <span className="pf-stage-flag">
                  <span className="pf-flag-track" aria-hidden="true"><span style={{ width: `${(flaggedShare || 0) * 100}%` }} /></span>
                  <span className="num">{t('{n} flagged ({pct})', { n: st.flagged.toLocaleString('en-IN'), pct: fmtPct(flaggedShare) })}</span>
                </span>
              </div>
              {i < arrows.length && (
                <div className="pf-arrow">
                  <span className="pf-arrow-icon" aria-hidden="true">↓</span>
                  <span><strong className="num">{fmtPct(arrows[i].rate)}</strong> {t(arrows[i].text)}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <p className="chart-footnote">{t('Bar width = share of all works that reached that stage. The line under each bar is the works stuck there now.')}</p>
    </div>
  )
}
