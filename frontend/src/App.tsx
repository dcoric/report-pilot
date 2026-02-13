import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppShell } from './components/Layout/AppShell';
import { Dashboard } from './pages/Dashboard';
import { DataSources } from './pages/DataSources';
import { SchemaExplorer } from './pages/SchemaExplorer';
import { QueryWorkspace } from './pages/QueryWorkspace';
import { Observability } from './pages/Observability';
import { ReleaseGates } from './pages/ReleaseGates';
import { NotFound } from './pages/NotFound';

function App() {
  return (
    <Router>
      <Toaster position="top-right" richColors />
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/data-sources" element={<DataSources />} />
          <Route path="/schema" element={<SchemaExplorer />} />
          <Route path="/query" element={<QueryWorkspace />} />
          <Route path="/observability" element={<Observability />} />
          <Route path="/release-gates" element={<ReleaseGates />} />

          {/* Settings placeholder for now */}
          <Route path="/settings" element={<div>Settings Page (Placeholder)</div>} />
        </Route>

        {/* 404 Route */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Router>
  );
}

export default App;
