import { FolderTree, History, MousePointerClick, Play, Settings } from 'lucide-react';
import { IconButton } from './ui.jsx';
import { statusColor } from './status.js';

const VIEWS = [
  ['run', 'Run', Play],
  ['history', 'History', History],
  ['library', 'Library', FolderTree],
];

// Shared header. It carries the run indicators even while another view is
// open, so a run started in Run stays visible while you browse history or
// reorganize.
//
// The nav only appears once the control plane is up — with no DB there is no
// Library to open and no history to browse (US-023: nothing about grouping
// renders before it exists).
export default function TopBar({ view, setView, showNav, runState, onOpenSettings }) {
  const { status, wsState, runId } = runState;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="brand">
          <span className="brand-mark">
            <MousePointerClick size={13} strokeWidth={2.4} aria-hidden="true" />
          </span>
          QAssist
        </span>

        {showNav && (
          <nav className="views">
            {VIEWS.map(([v, label, Icon]) => (
              <button
                key={v}
                type="button"
                className={v === view ? 'active' : ''}
                onClick={() => setView(v)}
              >
                <Icon size={14} strokeWidth={2} aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>
        )}

        <div className="top-right">
          {runId && (
            <>
              <span className={`ws ws-${wsState}`}>{wsState === 'live' ? 'live' : wsState}</span>
              <span className="badge" style={{ background: statusColor(status) }}>{status}</span>
            </>
          )}
          <IconButton icon={Settings} label="Settings" onClick={onOpenSettings} />
        </div>
      </div>
    </header>
  );
}
