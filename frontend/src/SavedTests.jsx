import { useState } from 'react';
import {
  ChevronDown, ChevronRight, FileText, PanelLeftClose, Pencil, Play, Plus, Search,
} from 'lucide-react';
import { CardHead, EmptyState, IconButton } from './ui.jsx';

// Saved-test rail (US-009, grouped in US-023). Presentational — RunView owns
// the data and handlers.
//
// Everything about grouping is conditional: with no projects this renders
// exactly the flat list it always did, and module headers only appear once the
// filtered project actually has modules.

// Which groups the viewer has folded shut, by module id (plus the two fixed
// keys below). Only *collapses* are stored, never opens: open is the default,
// so a rail nobody has touched can't be left folded by a state written on
// mount — the same rule `qassist_rail_state` follows in RunView.
const COLLAPSED_KEY = 'qassist_rail_collapsed';
const UNGROUPED = 'no-module';
const SUITES = 'suites';

// Below this the whole rail fits on one screen, and a filter box is chrome in
// front of a list you can already read. Measured on the fetched list rather
// than on what the box itself leaves, so it can't vanish mid-search.
const SEARCH_FROM = 8;

function readCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

export default function SavedTests({
  tests,
  projects,
  modules,
  filter,
  setFilter,
  activeTestId,
  running,
  onRun,
  onEdit,
  onNew,
  onRunModule,
  suites,
  onRunSuite,
  onCollapse,
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const hits = (text) => String(text ?? '').toLowerCase().includes(needle);
  // Name and start URL only — both are on the row, so every match is a match
  // you can see. Matching the goal would hide the reason a row survived.
  const shown = needle ? tests.filter((t) => hits(t.name) || hits(t.start_url)) : tests;
  const shownSuites = needle ? suites.filter((s) => hits(s.name)) : suites;

  const grouped = modules.length > 0;
  const ungrouped = grouped ? shown.filter((t) => !t.module_id) : shown;

  // A search is a result view, not a tree: a group is open because it holds a
  // hit, and the remembered folds come back when the box is cleared. That is
  // also why the chevron goes away while searching — a toggle whose clicks the
  // search overrules is a broken control.
  const isOpen = (key, count) => (needle ? count > 0 : !collapsed.has(key));
  const toggler = (key) =>
    needle
      ? undefined
      : () =>
          setCollapsed((cur) => {
            const next = new Set(cur);
            if (!next.delete(key)) next.add(key);
            localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
            return next;
          });

  const row = (t) => (
    <TestRow
      key={t.id}
      test={t}
      active={t.id === activeTestId}
      running={running}
      onRun={onRun}
      onEdit={onEdit}
    />
  );

  return (
    <>
      <CardHead title="Tests" count={needle ? shown.length : tests.length}>
        <IconButton icon={Plus} label="New test" onClick={onNew} className="spacer" />
        <IconButton icon={PanelLeftClose} label="Minimize tests" onClick={onCollapse} />
      </CardHead>

      {(projects.length > 0 || tests.length >= SEARCH_FROM) && (
        <div className="rail-filters">
          {projects.length > 0 && (
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">All tests</option>
              <option value="none">Ungrouped</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
          {tests.length >= SEARCH_FROM && (
            <div className="rail-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                value={query}
                aria-label="Filter tests"
                placeholder="Filter by name or URL"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              />
            </div>
          )}
        </div>
      )}

      {needle && shown.length === 0 && shownSuites.length === 0 ? (
        <EmptyState icon={Search} title="No matches">
          Nothing in this list matches “{query.trim()}”. Try part of a test name or its URL.
        </EmptyState>
      ) : tests.length === 0 && !grouped ? (
        <EmptyState icon={FileText} title="No saved tests">
          {filter === 'all'
            ? 'Save a run as a test and it re-runs with one click, keeping its own history.'
            : 'Nothing in this project yet — save a test here, or move an existing one into it.'}
        </EmptyState>
      ) : (
        <>
          {modules.map((m) => {
            const members = shown.filter((t) => t.module_id === m.id);
            // A module the search left empty is not a fold, it is a miss.
            if (needle && members.length === 0) return null;
            return (
              <Group
                key={m.id}
                name={m.name}
                count={members.length}
                open={isOpen(m.id, members.length)}
                onToggle={toggler(m.id)}
                action={
                  <IconButton
                    icon={Play}
                    variant="accent"
                    label={members.length ? `Run all of "${m.name}"` : 'No tests in this module'}
                    onClick={() => onRunModule(m, members.length)}
                    disabled={running || !members.length}
                  />
                }
              >
                {members.length > 0 && <ul className="list">{members.map(row)}</ul>}
              </Group>
            );
          })}

          {(ungrouped.length > 0 || !grouped) &&
            (grouped ? (
              <Group
                name="No module"
                muted
                count={ungrouped.length}
                open={isOpen(UNGROUPED, ungrouped.length)}
                onToggle={toggler(UNGROUPED)}
              >
                <ul className="list">{ungrouped.map(row)}</ul>
              </Group>
            ) : (
              <div className="group">
                <ul className="list">{ungrouped.map(row)}</ul>
              </div>
            ))}
        </>
      )}

      {shownSuites.length > 0 && (
        <Group
          name="Suites"
          muted
          count={shownSuites.length}
          open={isOpen(SUITES, shownSuites.length)}
          onToggle={toggler(SUITES)}
        >
          <ul className="list">
            {shownSuites.map((s) => (
              <li key={s.id}>
                <span className="row-main">
                  <span className="row-name">{s.name}</span>
                  <span className="row-sub">
                    {s.test_ids.length} test{s.test_ids.length === 1 ? '' : 's'}
                  </span>
                </span>
                <IconButton
                  icon={Play}
                  variant="accent"
                  label={s.test_ids.length ? `Run suite "${s.name}"` : 'Suite is empty'}
                  onClick={() => onRunSuite(s)}
                  disabled={running || !s.test_ids.length}
                />
              </li>
            ))}
          </ul>
          <p className="hint">Edit suites in Projects.</p>
        </Group>
      )}
    </>
  );
}

// A named section of the rail. `onToggle` is what makes it foldable — omitted,
// the head is the plain label it has always been.
function Group({ name, muted, count, open, onToggle, action, children }) {
  const label = (
    <>
      <span className={`group-name${muted ? ' muted' : ''}`}>{name}</span>
      <span className="card-count">{count}</span>
    </>
  );
  return (
    <div className="group">
      <div className="group-head">
        {onToggle ? (
          <button type="button" className="group-toggle" aria-expanded={open} onClick={onToggle}>
            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            {label}
          </button>
        ) : (
          label
        )}
        {action}
      </div>
      {open && children}
    </div>
  );
}

function TestRow({ test: t, active, running, onRun, onEdit }) {
  return (
    <li className={active ? 'active' : ''}>
      <span className="row-main" title={t.goal}>
        <span className="row-name">{t.name}</span>
        <span className="row-sub">{t.start_url}</span>
      </span>
      {/* Run stays visible — it is why the list exists. Edit is a hover/focus
          action so the rail reads as content, not a toolbar; delete is rarer
          still and lives in the edit dialog. */}
      <span className="row-actions">
        <IconButton icon={Pencil} label="Edit" onClick={() => onEdit(t)} />
      </span>
      <IconButton
        icon={Play}
        variant="accent"
        label={`Run "${t.name}"`}
        onClick={() => onRun(t)}
        disabled={running}
      />
    </li>
  );
}
