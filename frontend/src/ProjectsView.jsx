import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, Bell, Boxes, FolderTree, KeyRound, Layers, Paperclip, Pencil, Plus, Terminal,
} from 'lucide-react';
import { api } from './api.js';
import CiCommand from './CiCommand.jsx';
import Fixtures from './Fixtures.jsx';
import GroupEditor, { changedFields } from './GroupEditor.jsx';
import Modules from './Modules.jsx';
import NotifyPrefs from './NotifyPrefs.jsx';
import Sessions from './Sessions.jsx';
import Suites from './Suites.jsx';
import { Button, CardHead, EmptyState, PageHeader } from './ui.jsx';

// Projects (US-023): full-width management of projects and everything they
// hold. Running lives in the Run view — this view only organizes.
//
// Master and detail, and the URL names both: `/projects/<slug>/<section>`. The
// four things a project holds are peers, not a stack, so they are a tab strip
// rather than four sections down one column — stacked, a project with a dozen
// suites buried its sessions and files below the fold, where nothing said they
// existed. Naming the section in the URL is what makes each one linkable, gives
// the back button something to do, and keeps the section you are working in
// while you click through projects comparing them.
//
// The counts come from the project detail (`suite_count` and friends) rather
// than from each section, because a count you can only see after opening the
// section is not navigation.
const TABS = [
  { key: 'modules', label: 'Modules', icon: Layers, count: (d) => d.modules.length },
  { key: 'suites', label: 'Suites', icon: Boxes, count: (d) => d.suite_count },
  { key: 'sessions', label: 'Sessions', icon: KeyRound, count: (d) => d.session_count },
  { key: 'files', label: 'Files', icon: Paperclip, count: (d) => d.fixture_count },
];

// Where the rail earns a filter. Below this the whole list is on screen and a
// filter is one more control between you and clicking the thing you can see.
const FILTER_FROM = 8;

export default function ProjectsView({ token, health }) {
  const { slug, tab } = useParams();
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [detail, setDetail] = useState(null);
  // A slug in the URL that the server doesn't have — a stale link or a bookmark
  // to something deleted. Distinct from "nothing selected yet", which is what
  // an empty control plane looks like.
  const [missing, setMissing] = useState(false);
  const [filter, setFilter] = useState('');
  const [newProject, setNewProject] = useState('');
  // { name, slug } — the draft rename of the selected project, or null.
  const [editing, setEditing] = useState(null);
  // The row whose CI command is on screen; see CiCommand for the shape.
  const [ciTarget, setCiTarget] = useState(null);
  // The project whose notification prefs are being edited (US-012).
  const [notifyProject, setNotifyProject] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const active = TABS.find((t) => t.key === tab) || TABS[0];
  const hrefFor = (projectSlug, section = active.key) => `/projects/${projectSlug}/${section}`;

  const loadProjects = useCallback(async () => {
    try {
      const { projects: rows } = await api('/api/projects', { token });
      setProjects(rows);
    } catch (err) {
      setError(`Projects: ${err.message}`);
    }
  }, [token]);

  // Fetched by slug, which the API accepts wherever it accepts a uuid — so the
  // URL stays the readable thing a person would type.
  const loadDetail = useCallback(async () => {
    if (!slug) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await api(`/api/projects/${encodeURIComponent(slug)}`, { token }));
      setMissing(false);
    } catch (err) {
      if (err.status === 404) {
        setDetail(null);
        setMissing(true);
      } else {
        setError(`Project: ${err.message}`);
      }
    }
  }, [slug, token]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // A bare /projects opens the newest project (the list is newest first) — the
  // view is only ever reached to work on something, and an empty pane beside a
  // full list is a click nobody wanted to make.
  useEffect(() => {
    if (!slug && projects.length) navigate(`/projects/${projects[0].slug}/${active.key}`, { replace: true });
  }, [slug, projects, active.key, navigate]);

  /** Refresh both the rail (counts live on its rows) and the open project. */
  const refresh = useCallback(
    () => Promise.all([loadProjects(), loadDetail()]),
    [loadProjects, loadDetail]
  );

  async function mutate(label, fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(null);
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
      await loadProjects();
      navigate(hrefFor(created.slug));
    });
  }

  function saveProject(e) {
    e.preventDefault();
    const body = changedFields(detail, editing);
    if (!Object.keys(body).length) return setEditing(null);
    mutate('Rename', async () => {
      const updated = await api(`/api/projects/${detail.id}`, { token, method: 'PUT', body });
      await loadProjects();
      // A re-slug moves the project's address, so the open page has to move
      // with it — reloading the detail under the old slug would 404 the thing
      // that was just renamed successfully.
      if (updated.slug !== slug) navigate(hrefFor(updated.slug), { replace: true });
      else await loadDetail();
    });
  }

  function deleteProject() {
    const warn =
      `Delete project "${detail.name}"?\n\n` +
      `Its ${detail.modules.length} module(s) and any suites go with it. ` +
      `Its ${detail.test_count} test(s) are kept and move back to Ungrouped.`;
    if (!window.confirm(warn)) return;
    mutate('Delete project', async () => {
      await api(`/api/projects/${detail.id}`, { token, method: 'DELETE' });
      await loadProjects();
      // Back to the bare path, which lands on whatever project is now first.
      navigate('/projects', { replace: true });
    });
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? projects.filter((p) => `${p.name} ${p.slug}`.toLowerCase().includes(needle))
    : projects;

  return (
    <>
      <PageHeader
        title="Projects"
        description="Organize saved tests into modules and suites, and keep the sessions and files they run with. Running happens in the Run view."
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
          {projects.length >= FILTER_FROM && (
            <input
              value={filter}
              placeholder="Filter by name or slug"
              aria-label="Filter projects"
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {projects.length === 0 && (
            <EmptyState icon={FolderTree} title="No projects yet">
              A project is one app under test — create one, then group its saved tests into
              modules like <code>auth</code> or <code>checkout</code>.
            </EmptyState>
          )}
          <ul className="list">
            {shown.map((p) => (
              <li key={p.id} className={p.slug === slug ? 'active' : ''}>
                <Link className="row-main" to={hrefFor(p.slug)}>
                  <span className="row-name">{p.name}</span>
                  <span className="row-sub">
                    <code>{p.slug}</code> · {p.test_count} test{p.test_count === 1 ? '' : 's'} ·{' '}
                    {p.module_count} module{p.module_count === 1 ? '' : 's'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {projects.length > 0 && shown.length === 0 && (
            <EmptyState>No project matches “{filter.trim()}”.</EmptyState>
          )}
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

        {/* No projects, no detail pane: the rail's own empty state is the whole
            story, and a second card saying "nothing selected" beside it is a
            card asking to be ignored. */}
        {(projects.length > 0 || missing) && (
          <section className="card proj-detail">
            {missing ? (
              <EmptyState icon={FolderTree} title="That project isn't here">
                It was renamed or deleted since this link was made. Pick one from the list.
              </EmptyState>
            ) : (
              detail && (
                <>
                  <div className="proj-head">
                    {editing ? (
                      <GroupEditor
                        draft={editing}
                        setDraft={setEditing}
                        onSubmit={saveProject}
                        onCancel={() => setEditing(null)}
                        onDelete={deleteProject}
                        busy={busy}
                      />
                    ) : (
                      <>
                        <div className="proj-id">
                          <h2>{detail.name}</h2>
                          <span className="row-sub">
                            <code>{detail.slug}</code> · {detail.test_count} test
                            {detail.test_count === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div className="proj-head-actions">
                          <Button size="sm" icon={Bell} onClick={() => setNotifyProject(detail)}>
                            Notifications
                          </Button>
                          <Button
                            size="sm"
                            icon={Terminal}
                            onClick={() =>
                              setCiTarget({
                                kind: 'project',
                                name: detail.name,
                                project: detail.slug,
                              })
                            }
                          >
                            Run from CI
                          </Button>
                          <Button
                            size="sm"
                            icon={Pencil}
                            onClick={() => {
                              setError(null);
                              setEditing({ name: detail.name, slug: detail.slug });
                            }}
                          >
                            Edit
                          </Button>
                        </div>
                      </>
                    )}
                  </div>

                  <nav className="tabs" aria-label="Project sections">
                    {TABS.map(({ key, label, icon: Icon, count }) => (
                      <Link
                        key={key}
                        to={hrefFor(detail.slug, key)}
                        aria-current={key === active.key ? 'page' : undefined}
                      >
                        <Icon size={13} strokeWidth={2} aria-hidden="true" />
                        {label}
                        <span className="tab-count">{count(detail)}</span>
                      </Link>
                    ))}
                  </nav>

                  {active.key === 'modules' && (
                    <Modules project={detail} token={token} onChanged={refresh} />
                  )}
                  {active.key === 'suites' && (
                    <Suites projectId={detail.id} token={token} onChanged={refresh} />
                  )}
                  {active.key === 'sessions' && (
                    <Sessions projectId={detail.id} token={token} onChanged={refresh} />
                  )}
                  {active.key === 'files' && (
                    <Fixtures projectId={detail.id} token={token} onChanged={refresh} />
                  )}
                </>
              )
            )}
          </section>
        )}
      </div>

      {ciTarget && <CiCommand target={ciTarget} onClose={() => setCiTarget(null)} />}

      {notifyProject && (
        <NotifyPrefs
          project={notifyProject}
          token={token}
          mailEnabled={!health || health.mail}
          onClose={() => setNotifyProject(null)}
          onSaved={refresh}
        />
      )}
    </>
  );
}
