import { FileText, PanelLeftClose, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { CardHead, EmptyState, IconButton } from './ui.jsx';

// Saved-test rail (US-009, grouped in US-023). Presentational — RunView owns
// the data and handlers.
//
// Everything about grouping is conditional: with no projects this renders
// exactly the flat list it always did, and module headers only appear once the
// filtered project actually has modules.
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
  onDelete,
  onNew,
  onRunModule,
  suites,
  onRunSuite,
  onCollapse,
}) {
  const grouped = modules.length > 0;
  const ungrouped = grouped ? tests.filter((t) => !t.module_id) : tests;

  const row = (t) => (
    <TestRow
      key={t.id}
      test={t}
      active={t.id === activeTestId}
      running={running}
      onRun={onRun}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );

  return (
    <>
      <CardHead title="Tests" count={tests.length}>
        <IconButton icon={Plus} label="New test" onClick={onNew} className="spacer" />
        <IconButton icon={PanelLeftClose} label="Minimize tests" onClick={onCollapse} />
      </CardHead>

      {projects.length > 0 && (
        <select className="filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All tests</option>
          <option value="none">Ungrouped</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}

      {tests.length === 0 && !grouped ? (
        <EmptyState icon={FileText} title="No saved tests">
          {filter === 'all'
            ? 'Save a run as a test and it re-runs with one click, keeping its own history.'
            : 'Nothing in this project yet — save a test here, or move an existing one into it.'}
        </EmptyState>
      ) : (
        <>
          {modules.map((m) => {
            const members = tests.filter((t) => t.module_id === m.id);
            return (
              <div className="group" key={m.id}>
                <div className="group-head">
                  <span className="group-name">{m.name}</span>
                  <span className="card-count">{members.length}</span>
                  <IconButton
                    icon={Play}
                    variant="accent"
                    label={members.length ? `Run all of "${m.name}"` : 'No tests in this module'}
                    onClick={() => onRunModule(m, members.length)}
                    disabled={running || !members.length}
                  />
                </div>
                {members.length > 0 && <ul className="list">{members.map(row)}</ul>}
              </div>
            );
          })}

          {(ungrouped.length > 0 || !grouped) && (
            <div className="group">
              {grouped && (
                <div className="group-head">
                  <span className="group-name muted">No module</span>
                  <span className="card-count">{ungrouped.length}</span>
                </div>
              )}
              <ul className="list">{ungrouped.map(row)}</ul>
            </div>
          )}
        </>
      )}

      {suites.length > 0 && (
        <div className="group">
          <div className="group-head">
            <span className="group-name muted">Suites</span>
            <span className="card-count">{suites.length}</span>
          </div>
          <ul className="list">
            {suites.map((s) => (
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
          <p className="hint">Edit suites in Library.</p>
        </div>
      )}
    </>
  );
}

function TestRow({ test: t, active, running, onRun, onEdit, onDelete }) {
  return (
    <li className={active ? 'active' : ''}>
      <span className="row-main" title={t.goal}>
        <span className="row-name">{t.name}</span>
        <span className="row-sub">{t.start_url}</span>
      </span>
      {/* Run stays visible — it is why the list exists. Edit and delete are
          hover/focus actions so the rail reads as content, not a toolbar. */}
      <span className="row-actions">
        <IconButton icon={Pencil} label="Edit" onClick={() => onEdit(t)} />
        <IconButton icon={Trash2} variant="danger" label="Delete" onClick={() => onDelete(t)} />
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
