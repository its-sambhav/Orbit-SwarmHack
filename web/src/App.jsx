import { Route, Routes } from 'react-router-dom'
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
import { AgencyView } from './views/AgencyView'
import { CaseFileView } from './views/CaseFileView'
import { MpAuditsView } from './views/MpAuditsView'
import { MpProfileView } from './views/MpProfileView'
import { ReportsView } from './views/ReportsView'
import { AnomaliesView } from './views/AnomaliesView'

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
      <Route path="/anomalies" element={<AnomaliesView />} />
      <Route path="/state/:stateName" element={<StateView />} />
      {/* the Overview/Map split MoSPI's own NationalView/MospiMapView use -
          every "Overview" dashboard below gets its own separate Map page
          rather than an embedded, scrolled-to map on the same screen. */}
      <Route path="/state/:stateName/map" element={<StateMapView />} />
      {/* /district/... is MoSPI's own India > State > District drill-down
          (full MoSPI nav/search); /district-authority/... is the District
          Authority role's own dashboard (no MoSPI access) - same component,
          DistrictView branches its chrome on which path it was reached by. */}
      <Route path="/district/:stateName/:districtName" element={<DistrictView />} />
      <Route path="/district-authority/:stateName/:districtName" element={<DistrictView />} />
      <Route path="/district/:stateName/:districtName/map" element={<DistrictMapView />} />
      <Route path="/district-authority/:stateName/:districtName/map" element={<DistrictMapView />} />
      {/* /mp/:id is the MP's own purpose-built dashboard (portfolio framing,
          not an audit queue); /constituency/:id stays MoSPI's own drill-down
          (same component MP Audits' profile pages link out to). */}
      <Route path="/mp/:id" element={<MpDashboardView />} />
      <Route path="/mp/:id/map" element={<MpMapView />} />
      <Route path="/constituency/:id" element={<ConstituencyView />} />
      <Route path="/agency/:agencyName" element={<AgencyView />} />
      <Route path="/work/:workNumber" element={<CaseFileView />} />
    </Routes>
  )
}
