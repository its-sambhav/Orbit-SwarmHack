const BASE = '/api'

async function get(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString()
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function post(path, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}${path}?${qs}`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}))
    throw new Error(errBody.detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function del(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const api = {
  meta: () => get('/meta'),
  // { dateFrom, dateTo } is optional everywhere below - the date-range
  // filter on Overview + Map's India/State/District views narrows to works
  // recommended in that window (see api/data.py's Store.risk_tables).
  funnel: (scope, { dateFrom, dateTo } = {}) => get('/funnel', { scope, date_from: dateFrom, date_to: dateTo }),
  analytics: (scope, { dateFrom, dateTo } = {}) => get('/analytics', { scope, date_from: dateFrom, date_to: dateTo }),
  constituencies: (scope) => get('/constituencies', { scope }),
  queue: (params, { dateFrom, dateTo } = {}) => get('/queue', { ...params, date_from: dateFrom, date_to: dateTo }),
  work: (workNumber, scopeHouse, scopeTenure) =>
    get(`/work/${workNumber}`, { scope_house: scopeHouse, scope_tenure: scopeTenure }),
  constituency: (id, scope) => get(`/constituency/${id}`, { scope }),
  states: (params, { dateFrom, dateTo } = {}) => get('/states', { ...params, date_from: dateFrom, date_to: dateTo }),
  state: (name, scope, { dateFrom, dateTo } = {}) =>
    get(`/state/${encodeURIComponent(name)}`, { scope, date_from: dateFrom, date_to: dateTo }),
  districts: (state, scope) => get('/districts', { state, scope }),
  district: (state, district, scope, { dateFrom, dateTo } = {}) =>
    get(`/district/${encodeURIComponent(state)}/${encodeURIComponent(district)}`, { scope, date_from: dateFrom, date_to: dateTo }),
  narrative: (workNumber, scopeHouse, scopeTenure, findingId) =>
    post('/narrative', {
      work_number: workNumber, scope_house: scopeHouse,
      scope_tenure: scopeTenure, finding_id: findingId,
    }),
  mps: (params) => get('/mps', params),
  mp: (name, scope) => get(`/mp/${encodeURIComponent(name)}`, { scope }),
  reports: () => get('/reports'),
  createReport: (body) => postJson('/reports', body),
  deleteReport: (id) => del(`/reports/${id}`),
}

export function formatRupees(amount) {
  if (amount === null || amount === undefined) return '—'
  const abs = Math.abs(amount)
  if (abs >= 1e7) return `₹${(amount / 1e7).toFixed(2)} Cr`
  if (abs >= 1e5) return `₹${(amount / 1e5).toFixed(2)} L`
  return `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

export function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

// shared by every MoSPI page that has a search bar - one entry per real
// constituency/state name already present in an /api/constituencies response.
export function buildSearchIndex(constituencies) {
  if (!constituencies) return []
  const seen = new Set()
  const idx = []
  for (const c of constituencies.items) {
    if (!seen.has(`c:${c.constituency}`)) {
      seen.add(`c:${c.constituency}`)
      idx.push({ name: c.constituency, type: 'constituency', id: c.constituency_id })
    }
    if (!seen.has(`s:${c.state}`)) {
      seen.add(`s:${c.state}`)
      idx.push({ name: c.state, type: 'state' })
    }
  }
  return idx
}
