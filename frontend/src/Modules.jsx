import { useState } from 'react';
import { AlertTriangle, Layers, Pencil, Plus, Terminal } from 'lucide-react';
import { api } from './api.js';
import CiCommand from './CiCommand.jsx';
import GroupEditor, { changedFields } from './GroupEditor.jsx';
import { Button, CardHead, EmptyState, IconButton } from './ui.jsx';

// The Modules section of the Projects view (US-023), a sibling of Suites,
// Sessions and Files behind the same tab strip.
//
// It is handed the project the view already fetched instead of fetching for
// itself: a module list is part of what a project *is*, and the detail request
// carries it. Writes call `onChanged` so the list and the count on the tab
// above it refresh together.
export default function Modules({ project, token, onChanged }) {
  const [newModule, setNewModule] = useState('');
  // { id, name, slug } — the module being renamed, or null.
  const [draft, setDraft] = useState(null);
  // The module whose CI command is on screen; see CiCommand for the shape.
  const [ciTarget, setCiTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function mutate(label, fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setDraft(null);
      await onChanged();
    } catch (err) {
      setError(`${label}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function create(e) {
    e.preventDefault();
    const name = newModule.trim();
    if (!name) return;
    mutate('Create module', async () => {
      await api(`/api/projects/${project.id}/modules`, { token, method: 'POST', body: { name } });
      setNewModule('');
    });
  }

  function save(e) {
    e.preventDefault();
    const original = project.modules.find((m) => m.id === draft.id);
    const body = changedFields(original, draft);
    if (!Object.keys(body).length) return setDraft(null);
    mutate('Rename', () => api(`/api/modules/${draft.id}`, { token, method: 'PUT', body }));
  }

  function remove(m) {
    const warn =
      `Delete module "${m.name}"?\n\n` +
      `Its ${m.test_count} test(s) are kept and stay in the project, ungrouped.`;
    if (!window.confirm(warn)) return;
    mutate('Delete module', () => api(`/api/modules/${m.id}`, { token, method: 'DELETE' }));
  }

  return (
    <>
      {error && (
        <div className="error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {project.modules.length === 0 && (
        <EmptyState icon={Layers} title="No modules yet">
          A test belongs to at most one module, so modules split the project's tests into
          non-overlapping groups — each one runnable on its own.
        </EmptyState>
      )}

      <ul className="list">
        {project.modules.map((m) =>
          draft?.id === m.id ? (
            <li key={m.id} className="editing">
              <GroupEditor
                draft={draft}
                setDraft={setDraft}
                onSubmit={save}
                onCancel={() => setDraft(null)}
                onDelete={() => remove(m)}
                busy={busy}
              />
            </li>
          ) : (
            <li key={m.id}>
              <span className="row-main">
                <span className="row-name">{m.name}</span>
                <span className="row-sub">
                  <code>{m.slug}</code> · {m.test_count} test{m.test_count === 1 ? '' : 's'}
                </span>
              </span>
              <span className="row-actions">
                <IconButton
                  icon={Terminal}
                  label="Run from CI"
                  onClick={() =>
                    setCiTarget({
                      kind: 'module',
                      name: m.name,
                      project: project.slug,
                      module: m.slug,
                    })
                  }
                />
                <IconButton
                  icon={Pencil}
                  label="Edit"
                  onClick={() => setDraft({ id: m.id, name: m.name, slug: m.slug })}
                />
              </span>
            </li>
          )
        )}
      </ul>

      <form onSubmit={create} className="add-form">
        <input
          value={newModule}
          placeholder="New module name"
          onChange={(e) => setNewModule(e.target.value)}
        />
        <Button type="submit" variant="primary" icon={Plus} disabled={busy || !newModule.trim()}>
          Add
        </Button>
      </form>

      {ciTarget && <CiCommand target={ciTarget} onClose={() => setCiTarget(null)} />}
    </>
  );
}
