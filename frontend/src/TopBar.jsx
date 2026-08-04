import { CalendarClock, FolderTree, History, Play, Settings } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { BrandMark, IconButton } from './ui.jsx';
import { statusLabel } from './status.js';

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
        <BrandMark labelled />

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
                // The label is hidden below the phone breakpoint, where four
                // labelled tabs no longer fit the row, so the accessible name
                // has to come from somewhere the stylesheet can't take away.
                aria-label={label}
              >
                <Icon size={13} strokeWidth={2} aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
        )}

        <div className="top-right">
          {runId && (
            <>
              <span className={`ws ws-${wsState}`}>{wsState === 'live' ? 'live' : wsState}</span>
              <span className={`badge badge-${status}`}>{statusLabel(status)}</span>
            </>
          )}
          <IconButton icon={Settings} label="Settings" onClick={onOpenSettings} />
        </div>
      </div>
    </header>
  );
}
