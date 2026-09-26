import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { getSession, homePath } from './api'
import './app.css'
import './roles.css'
import { RoleSelector } from './views/RoleSelector'
import { NationalView } from './views/NationalView'
import { MospiMapView } from './views/MospiMapView'
import { StateView } from './views/StateView'
import { StateMapView } from './views/StateMapView'
import { DistrictView } from './views/DistrictView'
import { DistrictMapView } from './views/DistrictMapView'
import { ConstituencyView } from './views/ConstituencyView'
import { MpDashboardView } from './views/MpDashboardView'
import { MpMapView } from './views/MpMapView'
import { MpWorksView } from './views/MpWorksView'
import { AgencyView } from './views/AgencyView'
import { CaseFileView } from './views/CaseFileView'
import { MpAuditsView } from './views/MpAuditsView'
import { MpProfileView } from './views/MpProfileView'
import { ReportsView } from './views/ReportsView'
import { AnomaliesView } from './views/AnomaliesView'
import { NotFoundView } from './views/NotFoundView'

const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()

// per kind of page, each role's check that the page is its own (MoSPI may
// open every page); a role missing under a kind needs only the role itself -
// the API still scopes its data
const OWNS = {
  state: { state: (e, p) => same(e, p.stateName) },
  // a state desk drills into any district of its own state
  district: {
    state: (e, p) => same(e, p.stateName),
    district: (e, p) => same(e, `${p.stateName}|${p.districtName}`),
  },
  mp: { mp: (e, p) => same(e, p.id) },
  agency: { agency: (e, p) => same(e, p.agencyName) },
}

/** The UI half of access control: signed out goes to sign-in, a signed-in
 * desk outside its own role/entity goes back to its own dashboard. The API
 * enforces the same rules on every request - this only keeps a page from
 * rendering what the server will refuse to fill. */
function RequireAuth({ roles, owns, children }) {
  const params = useParams()
  const auth = getSession()
  if (!auth) return <Navigate to="/" replace />
  const check = owns && OWNS[owns]?.[auth.role]
  const allowed = auth.role === 'mospi' || (roles.includes(auth.role) && (!check || check(auth.entity, params)))
  return allowed ? children : <Navigate to={homePath(auth)} replace />
}

const guard = (element, roles = [], owns) => <RequireAuth roles={roles} owns={owns}>{element}</RequireAuth>

// Every role dashboard (State/District/Agency/MP) and every MoSPI page now
// shares the same MospiNav fixed-nav-+-drawer chrome - the old generic
// DashboardShell header this file used to define for StateView has no
// remaining consumer and has been removed, not left dead.
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RoleSelector />} />
      <Route path="/mospi" element={guard(<NationalView />)} />
      <Route path="/mospi/map" element={guard(<MospiMapView />)} />
      <Route path="/mp-audits" element={guard(<MpAuditsView />)} />
      <Route path="/mp-audits/:mpName" element={guard(<MpProfileView />)} />
      <Route path="/reports" element={guard(<ReportsView />)} />
      <Route path="/anomalies" element={guard(<AnomaliesView />)} />
      <Route path="/state/:stateName" element={guard(<StateView />, ['state'], 'state')} />
      {/* the Overview/Map split MoSPI's own NationalView/MospiMapView use -
          every "Overview" dashboard below gets its own separate Map page
          rather than an embedded, scrolled-to map on the same screen. */}
      <Route path="/state/:stateName/map" element={guard(<StateMapView />, ['state'], 'state')} />
      {/* /district/... is MoSPI's own India > State > District drill-down
          (full MoSPI nav/search); /district-authority/... is the District
          Authority role's own dashboard (no MoSPI access) - same component,
          DistrictView branches its chrome on which path it was reached by. */}
      <Route path="/district/:stateName/:districtName" element={guard(<DistrictView />, ['state', 'district'], 'district')} />
      <Route path="/district-authority/:stateName/:districtName" element={guard(<DistrictView />, ['district'], 'district')} />
      <Route path="/district/:stateName/:districtName/map" element={guard(<DistrictMapView />, ['state', 'district'], 'district')} />
      <Route path="/district-authority/:stateName/:districtName/map" element={guard(<DistrictMapView />, ['district'], 'district')} />
      {/* /mp/:id is the MP's own purpose-built dashboard (portfolio framing,
          not an audit queue); /constituency/:id stays MoSPI's own drill-down
          (same component MP Audits' profile pages link out to). */}
      <Route path="/mp/:id" element={guard(<MpDashboardView />, ['mp'], 'mp')} />
      <Route path="/mp/:id/map" element={guard(<MpMapView />, ['mp'], 'mp')} />
      <Route path="/mp/:id/works" element={guard(<MpWorksView />, ['mp'], 'mp')} />
      <Route path="/constituency/:id" element={guard(<ConstituencyView />, ['state', 'district', 'mp'])} />
      {/* a district desk opens the agencies working in it (DistrictView's agency panel) */}
      <Route path="/agency/:agencyName" element={guard(<AgencyView />, ['agency', 'district'], 'agency')} />
      <Route path="/work/:workNumber" element={guard(<CaseFileView />, ['state', 'district', 'mp', 'agency'])} />
      <Route path="*" element={<NotFoundView />} />
    </Routes>
  )
}
