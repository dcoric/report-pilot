import { BrowserRouter as Router, Navigate, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppShell } from './components/Layout/AppShell';
import { Dashboard } from './pages/Dashboard';
import { DataSources } from './pages/DataSources';
import { SchemaExplorer } from './pages/SchemaExplorer';
import { QueryWorkspace } from './pages/QueryWorkspace';
import { NotFound } from './pages/NotFound';
import { Settings } from './pages/Settings';
import { LLMProviders } from './pages/LLMProviders';

function App() {
  return (
    <Router>
      <Toaster position="top-right" richColors />
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/query" element={<QueryWorkspace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/data-sources" element={<DataSources />} />
          <Route path="/schema" element={<SchemaExplorer />} />
          <Route path="/observability" element={<Navigate to="/dashboard?tab=observability" replace />} />
          <Route path="/release-gates" element={<Navigate to="/dashboard?tab=release-gates" replace />} />
          <Route path="/llm-providers" element={<LLMProviders />} />
          <Route path="/settings" element={<Settings />} />
        </Route>

        {/* 404 Route */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Router>
  );
}

export default App;
