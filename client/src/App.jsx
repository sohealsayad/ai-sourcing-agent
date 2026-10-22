import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { EmptyState, Icon } from './components/ui.jsx';
import NewRequest from './pages/NewRequest.jsx';
import RequestDetail from './pages/RequestDetail.jsx';
import RequestList from './pages/RequestList.jsx';

const navClass = ({ isActive }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
    isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
  }`;

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-8 px-8">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm">
              <Icon name="layers" className="size-4" />
            </span>
            <span className="leading-tight">
              <span className="block text-[15px] font-semibold tracking-tight text-slate-900">Sourcing Desk</span>
              <span className="block text-[11px] font-medium text-slate-500">AI procurement workflow</span>
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={navClass}>
              Requests
            </NavLink>
            <NavLink to="/new" className={navClass}>
              New request
            </NavLink>
          </nav>
          <Link to="/new" className="btn-primary ml-auto">
            <Icon name="plus" /> New request
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-8 py-8">
        <Routes>
          <Route path="/" element={<RequestList />} />
          <Route path="/new" element={<NewRequest />} />
          <Route path="/requests/:id" element={<RequestDetail />} />
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
  );
}
