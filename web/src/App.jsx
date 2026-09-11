import { Link, Route, Routes } from 'react-router-dom'
import './app.css'
import './roles.css'
import { RoleSelector } from './views/RoleSelector'
import { NationalView } from './views/NationalView'
import { MospiMapView } from './views/MospiMapView'
import { StateView } from './views/StateView'
import { DistrictView } from './views/DistrictView'
import { ConstituencyView } from './views/ConstituencyView'
import { CaseFileView } from './views/CaseFileView'
import { MpAuditsView } from './views/MpAuditsView'
import { MpProfileView } from './views/MpProfileView'
import { ReportsView } from './views/ReportsView'

function DashboardShell({ children }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <div className="app-title">MPLADS Review</div>
          <div className="app-subtitle">Unsupervised prioritisation, not a verdict — every finding is a flag for human review.</div>
        </div>
        <Link className="switch-role-link" to="/">Switch role</Link>
      </header>
      <div className="app-body">{children}</div>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RoleSelector />} />
      {/* MoSPI owns its own fixed nav + page chrome (search, profile), so it
          skips the generic DashboardShell header used by the other 3 roles. */}
      <Route path="/mospi" element={<NationalView />} />
      <Route path="/mospi/map" element={<MospiMapView />} />
      <Route path="/mp-audits" element={<MpAuditsView />} />
      <Route path="/mp-audits/:mpName" element={<MpProfileView />} />
      <Route path="/reports" element={<ReportsView />} />
      {/* StateView is the separate State Nodal Authority role dashboard
          (reached from the role picker), not part of MoSPI's own drill-down -
          it keeps the generic DashboardShell header. District/Constituency/
          CaseFile are all reachable from MoSPI's own flows (map, MP Audits),
          so they share MospiNav's fixed nav + drawer for one consistent
          chrome across that whole workflow. */}
      <Route path="/state/:stateName" element={<DashboardShell><StateView /></DashboardShell>} />
      <Route path="/district/:stateName/:districtName" element={<DistrictView />} />
      <Route path="/mp/:id" element={<ConstituencyView />} />
      <Route path="/constituency/:id" element={<ConstituencyView />} />
      <Route path="/work/:workNumber" element={<CaseFileView />} />
    </Routes>
  )
}
