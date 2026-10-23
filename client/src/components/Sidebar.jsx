import { Link, NavLink, useLocation } from 'react-router-dom';
import { Icon } from './ui.jsx';

/** Dark, collapsible app sidebar. Collapsed it shows icons only (labels as tooltips). */
export default function Sidebar({ collapsed, onToggle }) {
  const { pathname } = useLocation();
  const sections = [
    {
      title: 'Workspace',
      items: [
        { to: '/', label: 'Requests', icon: 'list', active: pathname === '/' || pathname.startsWith('/requests') },
        { to: '/new', label: 'New request', icon: 'filePlus', active: pathname === '/new' },
      ],
    },
    {
      title: 'Procurement',
      items: [
        { to: '/suppliers', label: 'Suppliers', icon: 'users' },
        { to: '/quotes', label: 'Quotes', icon: 'receipt' },
        { to: '/negotiations', label: 'Negotiations', icon: 'messages' },
        { to: '/approvals', label: 'Approvals', icon: 'badgeCheck' },
      ],
    },
    { title: 'System', items: [{ to: '/settings', label: 'Settings', icon: 'settings' }] },
  ].map((section) => ({
    ...section,
    items: section.items.map((item) => ({ ...item, active: item.active ?? pathname.startsWith(item.to) })),
  }));

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-slate-800 bg-slate-900 text-slate-300 transition-[width] duration-200 ${
        collapsed ? 'w-[72px]' : 'w-64'
      }`}
    >
      <div className={`flex h-16 items-center border-b border-slate-800 ${collapsed ? 'justify-center px-2' : 'px-5'}`}>
        {collapsed ? (
          <Link to="/" className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-sm" title="Sourcing Desk" aria-label="Sourcing Desk">
            <Icon name="layers" className="size-4" />
          </Link>
        ) : (
          <Link to="/" className="flex min-w-0 flex-1 items-center gap-2.5" title="Sourcing Desk">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-sm">
                <Icon name="layers" className="size-4" />
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-[15px] font-semibold tracking-tight text-white">Sourcing Desk</span>
                <span className="block truncate text-[11px] font-medium text-slate-400">AI procurement workflow</span>
              </span>
          </Link>
        )}
      </div>

      <div className={`pt-5 ${collapsed ? 'px-3' : 'px-4'}`}>
        <Link to="/new" className={`btn-primary w-full ${collapsed ? 'px-0' : ''}`} title="New request" aria-label="New request">
          <Icon name="plus" />
          {!collapsed && 'New request'}
        </Link>
      </div>

      <nav className={`mt-6 flex-1 space-y-5 overflow-y-auto ${collapsed ? 'px-3' : 'px-4'}`}>
        {sections.map((section) => (
          <div key={section.title} className="space-y-1">
            {collapsed ? (
              <span className="mx-auto mb-2 block h-px w-6 bg-slate-800" aria-hidden="true" />
            ) : (
              <p className="mb-2 px-3 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">{section.title}</p>
            )}
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end
                title={collapsed ? item.label : undefined}
                aria-label={collapsed ? item.label : undefined}
                className={`flex items-center rounded-lg text-sm font-medium transition-colors ${
                  collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2'
                } ${item.active ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-800/60 hover:text-white'}`}
              >
                <Icon name={item.icon} className={`size-[18px] shrink-0 ${item.active ? 'text-brand-400' : ''}`} />
                {!collapsed && item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className={`border-t border-slate-800 py-3 ${collapsed ? 'px-3' : 'px-4'}`}>
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`flex w-full items-center rounded-lg py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-white ${
            collapsed ? 'justify-center' : 'gap-3 px-3'
          }`}
        >
          <Icon name={collapsed ? 'chevronsRight' : 'chevronsLeft'} className="size-[18px]" />
          {!collapsed && 'Collapse'}
        </button>
      </div>
    </aside>
  );
}
