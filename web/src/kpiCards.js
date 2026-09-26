import { formatRupees } from './api'

// The dashboards' KPI cards, computed by api/kpis.py - one builder per kind of
// card, so the five role dashboards compose their own sets from the same
// definitions and wording. Label, subtitle and hover explainer are strings.js
// keys, translated here; `i` is useLanguage()'s { t, td }.

const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'))
const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`)
const join = (...parts) => parts.filter(Boolean).join(' ')
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

// "Most: Uttar Pradesh (1,311 works)." after the explainer, on the pages
// whose endpoint names the level below (a state's districts, India's states)
function top(x, { t, td }) {
  if (!x?.name) return ''
  return x.amount != null
    ? t('kpiDesc.topAmount', { name: td(x.name), amount: formatRupees(x.amount) })
    : t('kpiDesc.topWorks', { name: td(x.name), n: num(x.works) })
}

const CARDS = {
  moneyAtRisk: ({ money_at_risk: x }, i) => ({
    label: i.t('kpi.moneyAtRisk'),
    value: formatRupees(x.amount),
    sub: i.t('kpiSub.flaggedMoney', { n: num(x.works), pct: pct(x.share_of_sanctioned) }),
    description: join(i.t('kpiDesc.moneyAtRisk'), top(x.top, i)),
  }),
  highSeverity: ({ high_severity: x }, i) => ({
    label: i.t('kpi.highSeverity'),
    value: num(x.works),
    sub: i.t('kpiSub.involved', { amount: formatRupees(x.amount) }),
    description: join(i.t('kpiDesc.highSeverity'), top(x.top, i)),
  }),
  costOverruns: ({ cost_overruns: x }, i) => ({
    label: i.t('kpi.costOverruns'),
    value: num(x.works),
    sub: i.t('kpiSub.abovePeer', { amount: formatRupees(x.above_peer) }),
    description: join(i.t('kpiDesc.costOverruns'),
      x.typical_ratio != null && i.t('kpiDesc.typicalRatio', { x: x.typical_ratio }), top(x.top, i)),
  }),
  duplicates: ({ duplicates: x }, i) => ({
    label: i.t('kpi.duplicates'),
    value: num(x.works),
    sub: i.t('kpiSub.involved', { amount: formatRupees(x.amount) }),
    description: join(i.t('kpiDesc.duplicates'), top(x.top, i)),
  }),
  earlyWarning: ({ early_warning: x }, i) => ({
    label: i.t('kpi.earlyWarning'),
    value: num(x.works),
    sub: i.t('kpiSub.atStake', { amount: formatRupees(x.amount) }),
    description: join(i.t('kpiDesc.earlyWarning'), top(x.top, i)),
  }),
  delayed: ({ delayed: x, guideline: g }, i) => ({
    label: i.t('kpi.delayed'),
    value: num(x.works),
    sub: i.t('kpiSub.delayedSplit', { a: num(x.awaiting_sanction), b: num(x.unfinished) }),
    description: join(i.t('kpiDesc.delayed', { days: g.sanction_days }),
      x.on_time_sanction_rate != null && i.t('kpiDesc.onTimeSanction', { pct: pct(x.on_time_sanction_rate), days: g.sanction_days }),
      top(x.top, i)),
  }),
  evidenceMissing: ({ evidence_missing: x }, i) => ({
    label: i.t('kpi.evidenceMissing'),
    value: num(x.works),
    sub: i.t('kpiSub.ofCompleted', { pct: pct(x.share_of_completed) }),
    description: join(i.t('kpiDesc.evidenceMissing'), top(x.top, i)),
  }),
  paymentWithoutCompletion: ({ payment_without_completion: x }, i) => ({
    label: i.t('kpi.paymentWithoutCompletion'),
    value: num(x.works),
    sub: i.t('kpiSub.paid', { amount: formatRupees(x.amount) }),
    description: join(i.t('kpiDesc.paymentWithoutCompletion'), top(x.top, i)),
  }),
  sanctionBacklog: ({ sanction_backlog: x, guideline: g }, i) => ({
    label: i.t('kpi.sanctionBacklog', { days: g.sanction_days }),
    value: num(x.works),
    sub: i.t('kpiSub.recommendedAmt', { amount: formatRupees(x.amount) }),
    description: join(i.t('kpiDesc.sanctionBacklog', { days: g.sanction_days }),
      x.oldest_days != null && i.t('kpiDesc.oldest', { days: num(x.oldest_days) })),
  }),
  sanctionDueSoon: ({ sanction_due_soon: x, guideline: g }, i) => ({
    label: i.t('kpi.sanctionDueSoon'),
    value: num(x.works),
    sub: i.t('kpiSub.dueWithin', { days: g.due_soon_days }),
    description: i.t('kpiDesc.sanctionDueSoon', { days: g.sanction_days, soon: g.due_soon_days }),
  }),
  overdue: ({ overdue: x }, i) => ({
    label: i.t('kpi.overdue'),
    value: num(x.works),
    sub: i.t('kpiSub.sanctionedAmt', { amount: formatRupees(x.amount) }),
    description: i.t('kpiDesc.overdue'),
  }),
  assetsDelivered: ({ assets_delivered: x }, i) => ({
    label: i.t('kpi.assetsDelivered'),
    value: num(x.works),
    sub: i.t('kpiSub.spent', { amount: formatRupees(x.amount) }),
    description: i.t('kpiDesc.assetsDelivered'),
  }),
  daysToSanction: ({ days_to_sanction: x, guideline: g }, i) => ({
    label: i.t('kpi.daysToSanction'),
    value: x.median != null ? num(Math.round(x.median)) : '—',
    sub: i.t('kpiSub.guideline', { days: g.sanction_days }),
    description: i.t('kpiDesc.daysToSanction', { days: g.sanction_days }),
  }),
  flaggedShare: ({ flagged_share: x }, i) => ({
    label: i.t('kpi.flaggedShare'),
    value: pct(x.share),
    sub: x.state_average != null ? i.t('kpiSub.stateAverage', { pct: pct(x.state_average) }) : '—',
    description: i.t('kpiDesc.flaggedShare'),
  }),
  costAndDuplicates: ({ cost_or_duplicate: x, cost_overruns: c, duplicates: d }, i) => ({
    label: i.t('kpi.costAndDuplicates'),
    value: num(x.works),
    sub: i.t('kpiSub.costDupSplit', { c: num(c.works), d: num(d.works) }),
    description: i.t('kpiDesc.costAndDuplicates'),
  }),
  onTimeCompletion: ({ on_time_completion: x }, i) => ({
    label: i.t('kpi.onTimeCompletion'),
    value: pct(x.share),
    sub: i.t('kpiSub.onTimeOf', { n: num(x.on_time), m: num(x.completed) }),
    description: i.t('kpiDesc.onTimeCompletion'),
  }),
  // agency names run to 60+ characters: the card shows the start, the hover the whole
  agencyConcentration: ({ agency_concentration: x }, i) => ({
    label: i.t('kpi.agencyConcentration'),
    value: pct(x.share),
    sub: x.agency ? clip(i.td(x.agency), 40) : '—',
    description: join(i.t('kpiDesc.agencyConcentration'), x.agency && i.t('kpiDesc.largestAgency', { name: i.td(x.agency) })),
  }),
}

// what a clickable card opens, said at the end of its hover explainer: the
// anomalies queue, the queue filtered to exactly the card's works, the page's
// map, or the works list further down the page
const HINTS = { queue: 'kpiDesc.clickQueue', works: 'kpiDesc.clickWorks', map: 'kpiDesc.clickMap', list: 'kpiDesc.clickList' }

/** The cards for `kinds`, in that order, from an endpoint's `kpis` block.
 * `links` maps a kind to { onClick, hint } for the cards that open something
 * on that page - hint is one of HINTS' keys. */
export function kpiCards(kinds, kpis, i, links = {}) {
  return kinds.map((kind) => {
    const card = { kind, ...CARDS[kind](kpis, i) }
    const link = links[kind]
    return link ? { ...card, onClick: link.onClick, description: join(card.description, i.t(HINTS[link.hint])) } : card
  })
}
