import { Route, Routes } from 'react-router-dom'
import './app.css'
import './roles.css'
import { RoleSelector } from './views/RoleSelector'
import { NationalView } from './views/NationalView'
import { MospiMapView } from './views/MospiMapView'
import { StateView } from './views/StateView'
import { DistrictView } from './views/DistrictView'
import { ConstituencyView } from './views/ConstituencyView'
import { MpDashboardView } from './views/MpDashboardView'
import { AgencyView } from './views/AgencyView'
import { CaseFileView } from './views/CaseFileView'
import { MpAuditsView } from './views/MpAuditsView'
import { MpProfileView } from './views/MpProfileView'
import { ReportsView } from './views/ReportsView'

// Every role dashboard (State/District/Agency/MP) and every MoSPI page now
// shares the same MospiNav fixed-nav-+-drawer chrome - the old generic
// DashboardShell header this file used to define for StateView has no
// remaining consumer and has been removed, not left dead.
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RoleSelector />} />
      <Route path="/mospi" element={<NationalView />} />
      <Route path="/mospi/map" element={<MospiMapView />} />
      <Route path="/mp-audits" element={<MpAuditsView />} />
      <Route path="/mp-audits/:mpName" element={<MpProfileView />} />
      <Route path="/reports" element={<ReportsView />} />
      <Route path="/state/:stateName" element={<StateView />} />
      {/* /district/... is MoSPI's own India > State > District drill-down
          (full MoSPI nav/search); /district-authority/... is the District
          Authority role's own dashboard (no MoSPI access) - same component,
          DistrictView branches its chrome on which path it was reached by. */}
      <Route path="/district/:stateName/:districtName" element={<DistrictView />} />
      <Route path="/district-authority/:stateName/:districtName" element={<DistrictView />} />
      {/* /mp/:id is the MP's own purpose-built dashboard (portfolio framing,
          not an audit queue); /constituency/:id stays MoSPI's own drill-down
          (same component MP Audits' profile pages link out to). */}
      <Route path="/mp/:id" element={<MpDashboardView />} />
      <Route path="/constituency/:id" element={<ConstituencyView />} />
      <Route path="/agency/:agencyName" element={<AgencyView />} />
      <Route path="/work/:workNumber" element={<CaseFileView />} />
    </Routes>
  )
}
