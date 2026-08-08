import { BookOpen, CalendarClock, FolderTree, History, Play, Settings } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { BrandMark, IconButton } from './ui.jsx';
import { statusColor, statusLabel } from './status.js';

const VIEWS = [
  ['/', 'Run', Play],
  ['/history', 'History', History],
  ['/schedules', 'Schedules', CalendarClock],
  ['/projects', 'Projects', FolderTree],
];

// The user manual (US-070). Absolute and the same on every instance, including
// a self-hosted one: it is published from its own stack rather than built into
// the image, so a per-instance copy would be as old as the release it shipped
// with.
const MANUAL_URL = 'https://docs.qassist.run';

// Shared header. It carries the run indicators even while another view is
// open, so a run started in Run stays visible while you browse history or
// reorganize.
//
// The nav only appears once the control plane is up — with no DB there are no
// projects to open and no history to browse (US-023: nothing about grouping
// renders before it exists).
export default function TopBar({ showNav, runState, onOpenSettings }) {
  const { status, wsState, runId } = runState;
  // The phone bar is one row, and the WS state and the status pill do not fit
  // beside four tabs and two buttons. The Run tab carries the status instead
  // (`.tab-dot`, phone-only in CSS) and the WS word is dropped there: it is
  // diagnostics, and the live frame under it says the same thing.
  const runDot = Boolean(runId) && showNav;
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
                // On the phone the tab is also the only place the run's status
                // is shown, and a colour is not a name — so it joins the label
                // rather than being left to `.tab-dot` alone.
                aria-label={runDot && to === '/' ? `${label} — ${statusLabel(status)}` : label}
              >
                <Icon size={13} strokeWidth={2} aria-hidden="true" />
                <span>{label}</span>
                {runDot && to === '/' && (
                  <span className="tab-dot" style={{ background: statusColor(status) }} />
                )}
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
          <IconButton
            as="a"
            icon={BookOpen}
            label="Manual"
            href={MANUAL_URL}
            target="_blank"
            rel="noreferrer"
          />
          <IconButton icon={Settings} label="Settings" onClick={() => onOpenSettings()} />
        </div>
      </div>
    </header>
  );
}
