import { CalendarClock, FolderTree, History, Play, Settings } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { IconButton } from './ui.jsx';
import { statusLabel } from './status.js';

const VIEWS = [
  ['/', 'Run', Play],
  ['/history', 'History', History],
  ['/schedules', 'Schedules', CalendarClock],
  ['/projects', 'Projects', FolderTree],
];

// `public/qassist-mark.svg`, inlined rather than served as an <img>: the file's
// check is white, which is invisible on the light theme, so it takes the bar's
// text colour here. The green stroke is the brand and is fixed in both themes.
// The viewBox is cropped to the ink — the file carries the square padding a
// favicon needs, which as a header glyph would just be a hole on the left edge.
function BrandMark() {
  return (
    <svg className="brand" viewBox="20 20 86 74" fill="none" role="img" aria-label="QAssist">
      <path
        d="M26 60 L52 88 L100 26"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M26 60 L100 26"
        stroke="#3DDC97"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
        <BrandMark />

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
              <span className={`badge badge-${status}`}>{statusLabel(status)}</span>
            </>
          )}
          <IconButton icon={Settings} label="Settings" onClick={onOpenSettings} />
        </div>
      </div>
    </header>
  );
}
