import { BrowserRouter as Router, Navigate, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppShell } from './components/Layout/AppShell';
import { RequireAuth } from './components/Auth/RequireAuth';
import { AuthProvider } from './contexts/AuthContext';
import { DataSourceProvider } from './contexts/DataSourceContext';
import { Dashboard } from './pages/Dashboard';
import { DataSources } from './pages/DataSources';
import { SchemaExplorer } from './pages/SchemaExplorer';
import { QueryWorkspace } from './pages/QueryWorkspace';
import { SavedQueries } from './pages/SavedQueries';
import { ComingSoon } from './pages/ComingSoon';
import { Login } from './pages/Login';
import { NotFound } from './pages/NotFound';
import { Settings } from './pages/Settings';
import { LLMProviders } from './pages/LLMProviders';
import { AuthProviders } from './pages/AuthProviders';
import { AuditLog } from './pages/AuditLog';
import { PromptPresets } from './pages/PromptPresets';

function App() {
  return (
    <Router>
      <Toaster position="top-right" richColors duration={10000} />
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />

          <Route
            element={(
              <RequireAuth>
                <DataSourceProvider>
                  <AppShell />
                </DataSourceProvider>
              </RequireAuth>
            )}
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route
              path="/queries"
              element={(
                <RequireAuth permission="saved_queries.read">
                  <SavedQueries />
                </RequireAuth>
              )}
            />
            <Route
              path="/query"
              element={(
                <RequireAuth permission="query.run">
                  <QueryWorkspace />
                </RequireAuth>
              )}
            />
            <Route
              path="/data-sources"
              element={(
                <RequireAuth permission="data_sources.read">
                  <DataSources />
                </RequireAuth>
              )}
            />
            <Route
              path="/schema"
              element={(
                <RequireAuth permission="data_sources.read">
                  <SchemaExplorer />
                </RequireAuth>
              )}
            />
            <Route path="/observability" element={<Navigate to="/dashboard?tab=observability" replace />} />
            <Route path="/release-gates" element={<Navigate to="/dashboard?tab=release-gates" replace />} />
            <Route
              path="/llm-providers"
              element={(
                <RequireAuth permission="providers.read">
                  <LLMProviders />
                </RequireAuth>
              )}
            />
            <Route path="/settings" element={<Settings />} />
            <Route path="/prompts" element={<PromptPresets />} />
            <Route
              path="/admin/auth-providers"
              element={(
                <RequireAuth role="admin">
                  <AuthProviders />
                </RequireAuth>
              )}
            />
            <Route
              path="/admin/audit-log"
              element={(
                <RequireAuth role="admin">
                  <AuditLog />
                </RequireAuth>
              )}
            />
            <Route path="/folders" element={<ComingSoon />} />
            <Route path="/favorites" element={<ComingSoon />} />
            <Route path="/recent" element={<ComingSoon />} />
            <Route path="/docs" element={<ComingSoon />} />
          </Route>

          {/* 404 Route */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </Router>
  );
}

export default App;
