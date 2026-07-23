import { CalendarClock, FolderTree, History, Play, Settings } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { IconButton } from './ui.jsx';

const VIEWS = [
  ['/', 'Run', Play],
  ['/history', 'History', History],
  ['/schedules', 'Schedules', CalendarClock],
  ['/projects', 'Projects', FolderTree],
];

// Shared header. It carries the run indicators even while another view is
// open, so a run started in Run stays visible while you browse history or
// reorganize.
//
// The nav only appears once the control plane is up — with no DB there are no
// projects to open and no history to browse (US-023: nothing about grouping
// renders before it exists).
export default function TopBar({ showNav, runState, onOpenSettings }) {
  const { status, wsState, runId } = runState;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="brand">QAssist</span>

        {showNav && (
          <nav className="views">
            {VIEWS.map(([to, label, Icon]) => (
              <NavLink
                key={to}
                to={to}
                // Without `end` the root link matches every path, so Run would
                // read as active while History is open.
                end={to === '/'}
                className={({ isActive }) => (isActive ? 'active' : '')}
              >
                <Icon size={13} strokeWidth={2} aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </nav>
        )}

        <div className="top-right">
          {runId && (
            <>
              <span className={`ws ws-${wsState}`}>{wsState === 'live' ? 'live' : wsState}</span>
              <span className={`badge badge-${status}`}>{status}</span>
            </>
          )}
          <IconButton icon={Settings} label="Settings" onClick={onOpenSettings} />
        </div>
      </div>
    </header>
  );
}
