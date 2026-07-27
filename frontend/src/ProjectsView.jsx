import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bell, FolderTree, Layers, Pencil, Plus, Terminal, Trash2 } from 'lucide-react';
import { api } from './api.js';
import CiCommand from './CiCommand.jsx';
import Fixtures from './Fixtures.jsx';
import Sessions from './Sessions.jsx';
import NotifyPrefs from './NotifyPrefs.jsx';
import Suites from './Suites.jsx';
import { Button, CardHead, EmptyState, IconButton, PageHeader } from './ui.jsx';

// Projects (US-023): full-width management of projects and the modules inside
// them. Running lives in the Run view — this view only organizes.
//
// Renaming and re-slugging are separate acts on the server: a rename never
// re-slugs, because the slug is what a CI config points at. The editor
// therefore exposes both fields and sends only what changed.
export default function ProjectsView({ token, health }) {
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [newProject, setNewProject] = useState('');
  const [newModule, setNewModule] = useState('');
  // { kind: 'project' | 'module', id, name, slug } — the row being renamed.
  const [editing, setEditing] = useState(null);
  // The row whose CI command is on screen; see CiCommand for the shape.
  const [ciTarget, setCiTarget] = useState(null);
  // The project whose notification prefs are being edited (US-012).
  const [notifyProject, setNotifyProject] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadProjects = useCallback(async () => {
    try {
      const { projects: rows } = await api('/api/projects', { token });
      setProjects(rows);
      setSelectedId((cur) => (rows.some((p) => p.id === cur) ? cur : rows[0]?.id || null));
    } catch (err) {
      setError(`Projects: ${err.message}`);
    }
  }, [token]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Detail carries the module list; refetched whenever the selection changes
  // or a write invalidates it.
  const loadDetail = useCallback(async () => {
    if (!selectedId) return setDetail(null);
    try {
      setDetail(await api(`/api/projects/${selectedId}`, { token }));
    } catch (err) {
      setError(`Project: ${err.message}`);
    }
  }, [selectedId, token]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  /** Run a write, then refresh both lists (counts live on the project rows). */
  async function mutate(label, fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(null);
      await Promise.all([loadProjects(), loadDetail()]);
    } catch (err) {
      setError(`${label}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function createProject(e) {
    e.preventDefault();
    const name = newProject.trim();
    if (!name) return;
    mutate('Create project', async () => {
      const created = await api('/api/projects', { token, method: 'POST', body: { name } });
      setNewProject('');
      setSelectedId(created.id);
    });
  }

  function createModule(e) {
    e.preventDefault();
    const name = newModule.trim();
    if (!name || !selectedId) return;
    mutate('Create module', async () => {
      await api(`/api/projects/${selectedId}/modules`, { token, method: 'POST', body: { name } });
      setNewModule('');
    });
  }

  function saveEdit(e) {
    e.preventDefault();
    const { kind, id, name, slug } = editing;
    const original = kind === 'project' ? projects.find((p) => p.id === id) : detail.modules.find((m) => m.id === id);
    const body = {};
    if (name.trim() && name.trim() !== original.name) body.name = name.trim();
    if (slug.trim() !== original.slug) body.slug = slug.trim();
    if (!Object.keys(body).length) return setEditing(null);
    const path = kind === 'project' ? `/api/projects/${id}` : `/api/modules/${id}`;
    mutate('Rename', () => api(path, { token, method: 'PUT', body }));
  }

  function deleteProject(p) {
    const warn =
      `Delete project "${p.name}"?\n\n` +
      `Its ${p.module_count} module(s) and any suites go with it. ` +
      `Its ${p.test_count} test(s) are kept and move back to Ungrouped.`;
    if (!window.confirm(warn)) return;
    mutate('Delete project', () => api(`/api/projects/${p.id}`, { token, method: 'DELETE' }));
  }

  function deleteModule(m) {
    const warn =
      `Delete module "${m.name}"?\n\n` +
      `Its ${m.test_count} test(s) are kept and stay in the project, ungrouped.`;
    if (!window.confirm(warn)) return;
    mutate('Delete module', () => api(`/api/modules/${m.id}`, { token, method: 'DELETE' }));
  }

  const editingRow = (kind, id) => editing?.kind === kind && editing.id === id;
  const startEdit = (kind, row) => {
    setError(null);
    setEditing({ kind, id: row.id, name: row.name, slug: row.slug });
  };

  return (
    <>
      <PageHeader
        title="Projects"
        description="Organize saved tests into projects and modules. Running happens in the Run view."
      />

      {error && (
        <div className="error page-error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="projects">
        <section className="card proj-list">
          <CardHead title="All projects" count={projects.length} />
          {projects.length === 0 && (
            <EmptyState icon={FolderTree} title="No projects yet">
              A project is one app under test — create one, then group its saved tests into
              modules like <code>auth</code> or <code>checkout</code>.
            </EmptyState>
          )}
          <ul className="list">
            {projects.map((p) =>
              editingRow('project', p.id) ? (
                <li key={p.id} className="editing">
                  <GroupEditor editing={editing} setEditing={setEditing} onSubmit={saveEdit} onCancel={() => setEditing(null)} onDelete={() => deleteProject(p)} busy={busy} />
                </li>
              ) : (
                <li key={p.id} className={p.id === selectedId ? 'active' : ''}>
                  <button type="button" className="row-main" onClick={() => setSelectedId(p.id)}>
                    <span className="row-name">{p.name}</span>
                    <span className="row-sub">
                      <code>{p.slug}</code> · {p.test_count} test{p.test_count === 1 ? '' : 's'} ·{' '}
                      {p.module_count} module{p.module_count === 1 ? '' : 's'}
                    </span>
                  </button>
                  <span className="row-actions">
                    <IconButton
                      icon={Bell}
                      label="Notifications"
                      onClick={() => setNotifyProject(p)}
                    />
                    <IconButton
                      icon={Terminal}
                      label="Run from CI"
                      onClick={() => setCiTarget({ kind: 'project', name: p.name, project: p.slug })}
                    />
                    <IconButton icon={Pencil} label="Edit" onClick={() => startEdit('project', p)} />
                  </span>
                </li>
              )
            )}
          </ul>
          <form onSubmit={createProject} className="add-form">
            <input
              value={newProject}
              placeholder="New project name"
              onChange={(e) => setNewProject(e.target.value)}
            />
            <Button type="submit" variant="primary" icon={Plus} disabled={busy || !newProject.trim()}>
              Add
            </Button>
          </form>
        </section>

        <section className="card proj-detail">
          {!detail ? (
            <EmptyState icon={Layers} title="No project selected">
              Pick a project to manage its modules and suites.
            </EmptyState>
          ) : (
            <>
              <CardHead title={`Modules in ${detail.name}`}>
                <span className="row-sub spacer">
                  {detail.test_count} test{detail.test_count === 1 ? '' : 's'} in this project
                </span>
              </CardHead>
              {detail.modules.length === 0 && (
                <EmptyState icon={Layers} title="No modules yet">
                  A test belongs to at most one module, so modules split the project's tests into
                  non-overlapping groups — each one runnable on its own.
                </EmptyState>
              )}
              <ul className="list">
                {detail.modules.map((m) =>
                  editingRow('module', m.id) ? (
                    <li key={m.id} className="editing">
                      <GroupEditor editing={editing} setEditing={setEditing} onSubmit={saveEdit} onCancel={() => setEditing(null)} onDelete={() => deleteModule(m)} busy={busy} />
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
                              project: detail.slug,
                              module: m.slug,
                            })
                          }
                        />
                        <IconButton icon={Pencil} label="Edit" onClick={() => startEdit('module', m)} />
                      </span>
                    </li>
                  )
                )}
              </ul>
              <form onSubmit={createModule} className="add-form">
                <input
                  value={newModule}
                  placeholder="New module name"
                  onChange={(e) => setNewModule(e.target.value)}
                />
                <Button type="submit" variant="primary" icon={Plus} disabled={busy || !newModule.trim()}>
                  Add
                </Button>
              </form>
              <Suites projectId={detail.id} token={token} />
              <Fixtures projectId={detail.id} token={token} />
              <Sessions projectId={detail.id} token={token} />
            </>
          )}
        </section>
      </div>

      {ciTarget && <CiCommand target={ciTarget} onClose={() => setCiTarget(null)} />}

      {notifyProject && (
        <NotifyPrefs
          project={notifyProject}
          token={token}
          mailEnabled={!health || health.mail}
          onClose={() => setNotifyProject(null)}
          onSaved={loadProjects}
        />
      )}
    </>
  );
}

// Inline name + slug editor shared by the project and module rows. Delete
// lives in here rather than on the row: a row that carries every action at
// once is four icons wide before it says anything, and deleting is the one
// action worth a deliberate second step.
function GroupEditor({ editing, setEditing, onSubmit, onCancel, onDelete, busy }) {
  return (
    <form className="inline-edit" onSubmit={onSubmit}>
      <input
        value={editing.name}
        autoFocus
        placeholder="Name"
        onChange={(e) => setEditing((cur) => ({ ...cur, name: e.target.value }))}
      />
      <input
        value={editing.slug}
        placeholder="slug"
        className="slug"
        onChange={(e) => setEditing((cur) => ({ ...cur, slug: e.target.value }))}
      />
      <div className="inline-edit-actions">
        <Button size="sm" variant="danger" icon={Trash2} onClick={onDelete} disabled={busy}>
          Delete
        </Button>
        <Button size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" variant="primary" disabled={busy || !editing.name.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}
