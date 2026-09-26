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

// the picker token a correct role password earns before an entity is picked
// (api/auth.py) - held in memory for that one step, never stored: it reads
// only that role's pick list and is no session.
let pickerToken = null

export function setPickerToken(token) {
  pickerToken = token
  getCache.clear()
}

// the token's own expiry, read from its payload (signed, not secret - the
// API still checks the signature) so an expired session is dropped before
// a page renders whose every request would fail
function tokenExpired(token) {
  try {
    const { exp } = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')))
    return !exp || exp * 1000 <= Date.now()
  } catch {
    return true
  }
}

// where a signed-in desk lands: the route guard sends a desk back here from
// a page outside its jurisdiction, and the nav bar's emblem links here
export function homePath(auth) {
  const entity = auth?.entity || ''
  if (auth?.role === 'mospi') return '/mospi'
  if (auth?.role === 'state') return `/state/${encodeURIComponent(entity)}`
  if (auth?.role === 'district') {
    const [state, district] = entity.split('|')
    return `/district-authority/${encodeURIComponent(state)}/${encodeURIComponent(district)}`
  }
  if (auth?.role === 'mp') return `/mp/${encodeURIComponent(entity)}`
  if (auth?.role === 'agency') return `/agency/${encodeURIComponent(entity)}`
  return '/'
}

// the signed-in session, or null when signed out or expired
export function getSession() {
  const auth = getAuthInfo()
  if (!auth?.token) return null
  if (tokenExpired(auth.token)) {
    clearAuthToken()
    return null
  }
  return auth
}

export function setAuthToken(token, role, entity) {
  pickerToken = null
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
  pickerToken = null
  try {
    localStorage.removeItem(AUTH_KEY)
  } catch {
    // ignore
  }
  getCache.clear()
}

function authHeaders() {
  const token = getAuthInfo()?.token || pickerToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// a 401 on a signed-in request means the session is gone (expired, or the
// server's AUTH_SECRET rotated) - drop it and start over at the sign-in page
function checkSession(res) {
  if (res.status === 401 && getAuthInfo()?.token) {
    clearAuthToken()
    window.location.replace('/?expired=1')
  }
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
      checkSession(res)
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
    checkSession(res)
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function post(path, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}${path}?${qs}`, { method: 'POST', headers: authHeaders() })
  if (!res.ok) {
    checkSession(res)
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
    // a wrong password at the sign-in form is not a lost session
    if (path !== '/auth/login') checkSession(res)
    const errBody = await res.json().catch(() => ({}))
    // status rides along so a caller can tell failures apart (the login page
    // needs 400 "entity required" vs 401 "wrong password").
    throw Object.assign(new Error(errBody.detail || `${res.status} ${res.statusText}`), { status: res.status })
  }
  return res.json()
}

async function patchJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    checkSession(res)
    const errBody = await res.json().catch(() => ({}))
    throw Object.assign(new Error(errBody.detail || `${res.status} ${res.statusText}`), { status: res.status })
  }
  return res.json()
}

// multipart: the browser sets its own Content-Type (with the boundary), so
// unlike postJson this must not send one of its own
async function postFile(path, file) {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: authHeaders(), body: form })
  if (!res.ok) {
    checkSession(res)
    const errBody = await res.json().catch(() => ({}))
    throw Object.assign(new Error(errBody.detail || `${res.status} ${res.statusText}`), { status: res.status })
  }
  return res.json()
}

async function fetchBlob(path, filename) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() })
  if (!res.ok) {
    checkSession(res)
    const errBody = await res.json().catch(() => ({}))
    throw new Error(errBody.detail || `${res.status} ${res.statusText}`)
  }
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = filename || 'document'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function del(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: authHeaders() })
  if (!res.ok) {
    checkSession(res)
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
  // the case discussion on one work (api/comments.py). Reads bypass the
  // shared GET cache - this app writes to the thread itself, and a stale
  // read straight after posting would drop the comment that was just made.
  comments: (workNumber, scopeHouse, scopeTenure) =>
    getFresh('/comments', { work_number: workNumber, scope_house: scopeHouse, scope_tenure: scopeTenure }),
  addComment: (body) => postJson('/comments', body),
  updateComment: (id, patch) => patchJson(`/comments/${id}`, patch),
  deleteComment: (id) => del(`/comments/${id}`),
  attachToComment: (id, file) => postFile(`/comments/${id}/attachments`, file),
  // a plain href can't carry the auth header, so the file is fetched and
  // handed to the browser as a blob - same download either way
  downloadAttachment: (commentId, attachmentId, filename) =>
    fetchBlob(`/comments/${commentId}/attachments/${attachmentId}`, filename),
  // English -> `lang` for the DATA strings on the current page (work
  // descriptions, place/person/agency names). See api/translate.py - the
  // response only carries what it could translate, the rest stays English.
  translate: (lang, texts) => postJson('/translate', { lang, texts }),
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
  // comments that mention the signed-in desk, on works that desk is
  // responsible for (api/main.py get_mentions)
  mentions: () => getFresh('/mentions'),
  markMentionsSeen: () => postJson('/mentions/seen', {}),
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

// shared by every review-queue/findings panel that gets its own search box
// (MospiMapView, StateMapView, DistrictMapView, ConstituencyView) - these
// each already hold their full (already-fetched, unpaginated) list of up to
// a couple hundred works client-side, so a plain substring filter over the
// fields a reviewer would actually type - constituency, MP, work number, the
// work's own description - is enough; no round trip needed. AnomaliesView is
// the one exception (its queue is the real, hundreds-of-thousands-strong
// dataset, paginated server-side), so it searches via /api/queue's own `q`
// param instead of this.
export function queueItemMatches(item, query) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [item.constituency, item.state, item.district, item.mp_name, item.work_number, item.work_description]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q))
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
