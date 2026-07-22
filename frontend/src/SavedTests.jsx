// Saved-test list (US-009). Presentational — App owns the data and handlers.
export default function SavedTests({ tests, activeTestId, editingId, running, onRun, onEdit, onDelete }) {
  return (
    <div className="tests">
      <h2>Saved tests</h2>
      {tests.length === 0 ? (
        <p className="tests-empty">
          No saved tests yet — run something below, then save it for one-click reuse.
        </p>
      ) : (
        <ul className="test-list">
          {tests.map((t) => (
            <li
              key={t.id}
              className={[t.id === activeTestId && 'active', t.id === editingId && 'editing']
                .filter(Boolean)
                .join(' ')}
            >
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
              <button
                type="button"
                className="icon-btn danger"
                title="Delete"
                onClick={() => onDelete(t)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
