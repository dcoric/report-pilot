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
import { Settings } from './pages/Settings';

function App() {
  return (
    <Router>
      <Toaster position="top-right" richColors />
      <Routes>
        {/* QueryWorkspace has its own complete layout, so it doesn't use AppShell */}
        <Route path="/" element={<QueryWorkspace />} />
        <Route path="/query" element={<QueryWorkspace />} />

        {/* Other pages still use the traditional AppShell layout */}
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/data-sources" element={<DataSources />} />
          <Route path="/schema" element={<SchemaExplorer />} />
          <Route path="/observability" element={<Observability />} />
          <Route path="/release-gates" element={<ReleaseGates />} />
          <Route path="/settings" element={<Settings />} />
        </Route>

        {/* 404 Route */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Router>
  );
}

export default App;
