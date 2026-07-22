import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Boxes, Pencil, Plus, Terminal, Trash2 } from 'lucide-react';
import { api } from './api.js';
import CiCommand from './CiCommand.jsx';
import { Button, CardHead, EmptyState, IconButton } from './ui.jsx';

// Suites (US-009 UI, deferred until US-023). A suite is the many-to-many
// alternative to a module: the same test can sit in several suites, but a
// suite lives inside one project and may only hold that project's tests
// (US-023 decision 6) — which is why the membership picker is a checkbox list
// over the project's tests and nothing else.
//
// Editing happens here rather than in the Run view because the multi-select
// needs the width. Running a suite lives in Run, next to the viewer.
export default function Suites({ projectId, token }) {
  const [suites, setSuites] = useState([]);
  const [tests, setTests] = useState([]);
  // { id: string|null, name, testIds } — id null while creating.
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The suite whose CI command is on screen; see CiCommand for the shape.
  const [ciTarget, setCiTarget] = useState(null);

  const load = useCallback(async () => {
    try {
      const [{ suites: s }, { tests: t }] = await Promise.all([
        api(`/api/suites?project_id=${projectId}`, { token }),
        api(`/api/tests?project_id=${projectId}`, { token }),
      ]);
      setSuites(s);
      setTests(t);
    } catch (err) {
      setError(`Suites: ${err.message}`);
    }
  }, [projectId, token]);

  useEffect(() => {
    setEditing(null);
    load();
  }, [load]);

  async function mutate(label, fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(null);
      await load();
    } catch (err) {
      setError(`${label}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function save(e) {
    e.preventDefault();
    const name = editing.name.trim();
    if (!name) return;
    const body = { name, test_ids: editing.testIds };
    if (editing.id) {
      mutate('Save suite', () => api(`/api/suites/${editing.id}`, { token, method: 'PUT', body }));
    } else {
      mutate('Create suite', () =>
        api('/api/suites', { token, method: 'POST', body: { ...body, project_id: projectId } })
      );
    }
  }

  function remove(s) {
    if (!window.confirm(`Delete suite "${s.name}"?\n\nIts tests are not deleted.`)) return;
    mutate('Delete suite', () => api(`/api/suites/${s.id}`, { token, method: 'DELETE' }));
  }

  const toggle = (id) =>
    setEditing((cur) => ({
      ...cur,
      testIds: cur.testIds.includes(id)
        ? cur.testIds.filter((x) => x !== id)
        : [...cur.testIds, id],
    }));

  return (
    <div className="suites">
      <CardHead title="Suites" count={suites.length}>
        {!editing && (
          <Button
            size="sm"
            icon={Plus}
            className="spacer"
            onClick={() => setEditing({ id: null, name: '', testIds: [] })}
          >
            New suite
          </Button>
        )}
      </CardHead>

      {error && (
        <div className="error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {suites.length === 0 && !editing && (
        <EmptyState icon={Boxes} title="No suites yet">
          Unlike a module, a suite can hold any mix of this project's tests, and a test can be in
          several — useful for cross-cutting sets like <code>smoke</code> or <code>nightly</code>.
        </EmptyState>
      )}

      <ul className="list">
        {suites.map((s) =>
          editing?.id === s.id ? (
            <li key={s.id} className="editing">
              <SuiteEditor
                editing={editing}
                setEditing={setEditing}
                tests={tests}
                toggle={toggle}
                onSubmit={save}
                onCancel={() => setEditing(null)}
                busy={busy}
              />
            </li>
          ) : (
            <li key={s.id}>
              <span className="row-main">
                <span className="row-name">{s.name}</span>
                <span className="row-sub">
                  {s.test_ids.length} test{s.test_ids.length === 1 ? '' : 's'}
                  {s.test_ids.length === 0 && ' — add some to make it runnable'}
                </span>
              </span>
              <span className="row-actions">
                <IconButton
                  icon={Terminal}
                  label="Run from CI"
                  onClick={() => setCiTarget({ kind: 'suite', name: s.name, id: s.id })}
                />
                <IconButton
                  icon={Pencil}
                  label="Edit name and membership"
                  onClick={() => setEditing({ id: s.id, name: s.name, testIds: s.test_ids })}
                />
                <IconButton icon={Trash2} variant="danger" label="Delete" onClick={() => remove(s)} />
              </span>
            </li>
          )
        )}
        {editing && !editing.id && (
          <li className="editing">
            <SuiteEditor
              editing={editing}
              setEditing={setEditing}
              tests={tests}
              toggle={toggle}
              onSubmit={save}
              onCancel={() => setEditing(null)}
              busy={busy}
            />
          </li>
        )}
      </ul>

      {ciTarget && <CiCommand target={ciTarget} onClose={() => setCiTarget(null)} />}
    </div>
  );
}

function SuiteEditor({ editing, setEditing, tests, toggle, onSubmit, onCancel, busy }) {
  return (
    <form className="inline-edit" onSubmit={onSubmit}>
      <input
        value={editing.name}
        autoFocus
        placeholder="Suite name — smoke, nightly, …"
        onChange={(e) => setEditing((cur) => ({ ...cur, name: e.target.value }))}
      />
      {tests.length === 0 ? (
        <EmptyState>
          This project has no tests yet. Assign some to it from the Run view — a suite can only
          hold tests that belong to its own project.
        </EmptyState>
      ) : (
        <ul className="member-list">
          {tests.map((t) => (
            <li key={t.id}>
              <label>
                <input
                  type="checkbox"
                  checked={editing.testIds.includes(t.id)}
                  onChange={() => toggle(t.id)}
                />
                <span className="member-name">{t.name}</span>
                <span className="member-url">{t.start_url}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="inline-edit-actions">
        <Button size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" variant="primary" disabled={busy || !editing.name.trim()}>
          {editing.id ? 'Save suite' : 'Create suite'}
        </Button>
      </div>
    </form>
  );
}
