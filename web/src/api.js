const BASE = '/api'
const AUTH_KEY = 'mplads_auth'

// every state/district/constituency/etc. page re-fetches from scratch on
// every visit today, so drilling back into a place you already opened this
// session pays the same backend query cost again. Cache GET responses by
// their full URL (scope/date-range params included, since they're already
// part of the querystring) for the life of the page - navigating back to an
// already-fetched view is then instant instead of round-tripping again.
// Mutating calls (post/postJson/del) intentionally bypass this.
const getCache = new Map()

// {token, role, entity} for the signed-in role/entity, or null when signed
// out - read by every request below to attach Authorization, and by
// RoleSelector.jsx to know whether a password prompt is still needed.
export function getAuthInfo() {
  try {
    const raw = localStorage.getItem(AUTH_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function setAuthToken(token, role, entity) {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ token, role, entity }))
  } catch {
    // ignore (private window / storage disabled) - the token still works
    // for this page's lifetime, just won't survive a reload
  }
  // a stale cached read from a previous identity must never leak into a
  // new sign-in within the same SPA session (no full page reload happens
  // on login/logout, so getCache's URL-only key wouldn't otherwise notice).
  getCache.clear()
}

export function clearAuthToken() {
  try {
    localStorage.removeItem(AUTH_KEY)
  } catch {
    // ignore
  }
  getCache.clear()
}

function authHeaders() {
  const auth = getAuthInfo()
  return auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}
}

async function get(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString()
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`
  if (getCache.has(url)) return getCache.get(url)
  const promise = (async () => {
    const res = await fetch(url, { headers: authHeaders() })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.detail || `${res.status} ${res.statusText}`)
    }
    return res.json()
  })().catch((err) => {
    getCache.delete(url)
    throw err
  })
  getCache.set(url, promise)
  return promise
}

// map boundary files (data/geo, served at /static/geo) are optional at
// runtime. A missing one comes back as the API's 404 JSON body, which parses
// fine and used to reach <IndiaMap> as if it were a FeatureCollection (no
// `.features`), unmounting the whole page. Resolve to null on any failure or
// wrong shape instead, so every map view just renders without boundaries.
//
// These files are the same handful of static boundary shapes reused by every
// map view (state/constituency/district) - cached in memory once fetched so
// drilling from one map page into another (a route change, so the component
// remounts) doesn't re-download and re-parse a multi-hundred-KB geojson it
// already has. Only a successful, well-shaped result is cached - a failed
// attempt returns null without being cached, so a later retry can still
// succeed instead of permanently remembering a transient failure.
const geoCache = new Map()
export async function fetchGeo(file) {
  if (geoCache.has(file)) return geoCache.get(file)
  try {
    const res = await fetch(`/static/geo/${file}`)
    if (!res.ok) return null
    const json = await res.json()
    const result = Array.isArray(json?.features) ? json : null
    if (result) geoCache.set(file, result)
    return result
  } catch {
    return null
  }
}

// same request as get(), deliberately bypassing getCache - for resources
// this app itself mutates (e.g. finding_status, set via postJson below),
// where a stale cached read after our own write would silently show
// pre-update data with no cache-invalidation trigger to catch it.
async function getFresh(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString()
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`, { headers: authHeaders() })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function post(path, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}${path}?${qs}`, { method: 'POST', headers: authHeaders() })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}))
    // status rides along so a caller can tell failures apart (the login page
    // needs 400 "entity required" vs 401 "wrong password").
    throw Object.assign(new Error(errBody.detail || `${res.status} ${res.statusText}`), { status: res.status })
  }
  return res.json()
}

async function del(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: authHeaders() })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const api = {
  login: (role, password, entity) => postJson('/auth/login', { role, password, entity }),
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
  constituency: (id, scope, { dateFrom, dateTo } = {}) =>
    get(`/constituency/${id}`, { scope, date_from: dateFrom, date_to: dateTo }),
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
  // the ML-predicted delay-risk model (engine/predictive.py) - a signal
  // independent of the rule-based detectors above, not a replacement.
  predictRisk: (amount, state, activity, month) => postJson('/predict_risk', { amount, state, activity, month }),
  // composites that same model's prediction (fed from this work's own real
  // data, not hypothetical inputs) with this work's rule-based findings and
  // its top finding's LLM narrative, in one call.
  aiAssessment: (workNumber, scopeHouse, scopeTenure) =>
    get(`/work/${workNumber}/ai_assessment`, { scope_house: scopeHouse, scope_tenure: scopeTenure }),
  mps: (params) => get('/mps', params),
  mp: (name, scope, { dateFrom, dateTo } = {}) =>
    get(`/mp/${encodeURIComponent(name)}`, { scope, date_from: dateFrom, date_to: dateTo }),
  agencies: (params) => get('/agencies', params),
  agency: (name, scope, { dateFrom, dateTo } = {}) =>
    get(`/agency/${encodeURIComponent(name)}`, { scope, date_from: dateFrom, date_to: dateTo }),
  reports: () => get('/reports'),
  createReport: (body) => postJson('/reports', body),
  deleteReport: (id) => del(`/reports/${id}`),
  // an officer's review verdict on one finding - the store this reads/writes
  // is mutable app state, not a precomputed pipeline output, so it always
  // goes through getFresh, never the GET cache above.
  findingStatuses: () => getFresh('/findings/status'),
  setFindingStatus: (findingId, body) => postJson(`/findings/${encodeURIComponent(findingId)}/status`, body),
  // the nav bar's alert bell - a push-shaped digest of newly-surfaced
  // high-severity findings (engine/alerts.py), refreshed once per pipeline
  // run, not a live feed. getFresh (not the GET cache): a stale "0 new
  // alerts" cached from an earlier page must never survive a later run's
  // fresh digest landing on disk mid-session.
  alertsLatest: () => getFresh('/alerts/latest'),
}

export function formatRupees(amount) {
  if (amount === null || amount === undefined) return '—'
  const abs = Math.abs(amount)
  if (abs >= 1e7) return `₹${(amount / 1e7).toFixed(2)} Cr`
  if (abs >= 1e5) return `₹${(amount / 1e5).toFixed(2)} L`
  return `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

// /api/funnel, /api/state/:name, /api/district/:s/:d, /api/constituency/:id
// and /api/agency/:name all carry the same real, per-sector-category
// recommended/sanctioned/high_risk/completed breakdown (api/main.py's
// category_breakdown()) - this is the one shared reshape from that wire
// format into what <ProjectLifecycleBarChart> renders (highRisk not
// high_risk, amounts in crore not raw rupees).
export function mapCategoryBreakdown(items) {
  if (!items) return []
  return items.map((c) => ({
    sector: c.sector,
    recommended: c.recommended, recommended_cr: c.recommended_amount / 1e7,
    sanctioned: c.sanctioned, sanctioned_cr: c.sanctioned_amount / 1e7,
    highRisk: c.high_risk, highRisk_cr: c.high_risk_amount / 1e7,
    completed: c.completed, completed_cr: c.completed_amount / 1e7,
  }))
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
