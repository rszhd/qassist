// Saved-test list (US-009, grouped in US-023). Presentational — RunView owns
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
  editingId,
  running,
  onRun,
  onEdit,
  onDelete,
  onRunModule,
  suites,
  onRunSuite,
}) {
  const grouped = modules.length > 0;
  const ungrouped = grouped ? tests.filter((t) => !t.module_id) : tests;

  const row = (t) => (
    <TestRow
      key={t.id}
      test={t}
      active={t.id === activeTestId}
      editing={t.id === editingId}
      running={running}
      onRun={onRun}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );

  return (
    <div className="tests">
      <h2>Saved tests</h2>

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
        <p className="tests-empty">
          {filter === 'all'
            ? 'No saved tests yet — run something below, then save it for one-click reuse.'
            : 'No tests here yet — save one below, or move an existing test into this project.'}
        </p>
      ) : (
        <>
          {modules.map((m) => {
            const members = tests.filter((t) => t.module_id === m.id);
            return (
              <div className="module-group" key={m.id}>
                <div className="module-head">
                  <span className="module-name">{m.name}</span>
                  <span className="module-count">{members.length}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    title={members.length ? `Run all of "${m.name}"` : 'No tests in this module'}
                    onClick={() => onRunModule(m, members.length)}
                    disabled={running || !members.length}
                  >
                    ▶
                  </button>
                </div>
                {members.length > 0 && <ul className="test-list">{members.map(row)}</ul>}
              </div>
            );
          })}

          {(ungrouped.length > 0 || !grouped) && (
            <div className="module-group">
              {grouped && (
                <div className="module-head">
                  <span className="module-name muted">No module</span>
                  <span className="module-count">{ungrouped.length}</span>
                </div>
              )}
              <ul className="test-list">{ungrouped.map(row)}</ul>
            </div>
          )}
        </>
      )}

      {suites.length > 0 && (
        <div className="suite-strip">
          <div className="module-head">
            <span className="module-name muted">Suites</span>
          </div>
          <ul className="test-list">
            {suites.map((s) => (
              <li key={s.id}>
                <span className="test-meta">
                  <span className="test-name">{s.name}</span>
                  <span className="test-url">
                    {s.test_ids.length} test{s.test_ids.length === 1 ? '' : 's'}
                  </span>
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  title={s.test_ids.length ? `Run suite "${s.name}"` : 'Suite is empty'}
                  onClick={() => onRunSuite(s)}
                  disabled={running || !s.test_ids.length}
                >
                  ▶
                </button>
              </li>
            ))}
          </ul>
          <p className="suite-hint">Edit suites in Library.</p>
        </div>
      )}
    </div>
  );
}

function TestRow({ test: t, active, editing, running, onRun, onEdit, onDelete }) {
  return (
    <li className={[active && 'active', editing && 'editing'].filter(Boolean).join(' ')}>
      <span className="test-meta" title={t.goal}>
        <span className="test-name">{t.name}</span>
        <span className="test-url">{t.start_url}</span>
      </span>
      <button
        type="button"
        className="icon-btn"
        title={`Run "${t.name}"`}
        onClick={() => onRun(t)}
        disabled={running}
      >
        ▶
      </button>
      <button type="button" className="icon-btn" title="Edit" onClick={() => onEdit(t)}>
        ✎
      </button>
      <button type="button" className="icon-btn danger" title="Delete" onClick={() => onDelete(t)}>
        ✕
      </button>
    </li>
  );
}
