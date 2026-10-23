import { useCallback, useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import { EmptyState } from './components/ui.jsx';
import NewRequest from './pages/NewRequest.jsx';
import RequestDetail from './pages/RequestDetail.jsx';
import ApprovalsPage from './pages/ApprovalsPage.jsx';
import NegotiationsPage from './pages/NegotiationsPage.jsx';
import QuotesPage from './pages/QuotesPage.jsx';
import RequestList from './pages/RequestList.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import SuppliersPage from './pages/SuppliersPage.jsx';

const STORAGE_KEY = 'sourcing-desk:sidebar-collapsed';

// Remember the sidebar state per browser; storage may be unavailable (private mode), so never rely on it.
function readCollapsed() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

// The shortcut must not fire while the user is typing.
const isTypingTarget = (el) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export default function App() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = useCallback(
    () =>
      setCollapsed((value) => {
        try {
          localStorage.setItem(STORAGE_KEY, String(!value));
        } catch {
          // ignore
        }
        return !value;
      }),
    [],
  );

  // Ctrl+B (Cmd+B on Mac) shows or hides the sidebar.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b') return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  return (
    <div className="min-h-screen">
      <Sidebar collapsed={collapsed} onToggle={toggle} />

      <div className={`transition-[padding] duration-200 ${collapsed ? 'pl-[72px]' : 'pl-64'}`}>
        <Topbar collapsed={collapsed} onToggle={toggle} />
        <main className="mx-auto max-w-7xl px-8 py-8">
          <Routes>
            <Route path="/" element={<RequestList />} />
            <Route path="/new" element={<NewRequest />} />
            <Route path="/requests/:id" element={<RequestDetail />} />
            <Route path="/suppliers" element={<SuppliersPage />} />
            <Route path="/quotes" element={<QuotesPage />} />
            <Route path="/negotiations" element={<NegotiationsPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route
              path="*"
              element={
                <div className="card">
                  <EmptyState
                    icon="search"
                    title="Page not found"
                    description="The page you are looking for does not exist."
                    action={
                      <Link to="/" className="btn-secondary">
                        Back to requests
                      </Link>
                    }
                  />
                </div>
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}
