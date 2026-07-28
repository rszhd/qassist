import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from './api.js';
import { Button, EmptyState, Field, IconButton, Modal } from './ui.jsx';

// Saved browser sessions (US-043): the signed-in state this project's tests
// start from, so a suite tests the product instead of testing the login form
// twenty times. Per-project like fixtures and notification prefs, for the same
// reason — an authenticated identity is something a team owns once.
//
// A session is never readable back. It IS the credential: holding one is being
// logged in. So the row shows what tells a live session from a stale one — the
// counts and when it was captured — and offers replacing it rather than
// viewing it. That is deliberate, not an oversight, and the empty state says
// so, because a user who expects to see their cookies and cannot will
// otherwise assume it did not save.
export default function Sessions({ projectId, token, onChanged }) {
  const [sessions, setSessions] = useState([]);
  const [tests, setTests] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [sessionData, testData] = await Promise.all([
        api(`/api/projects/${projectId}/sessions`, { token }),
        api(`/api/tests?project_id=${projectId}`, { token }),
      ]);
      setSessions(sessionData.sessions);
      setTests(testData.tests);
    } catch (err) {
      setError(`Sessions: ${err.message}`);
    }
  }, [projectId, token]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(form) {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name.trim(),
        login_test_id: form.login_test_id || null,
        verify_url_contains: form.verify_url_contains.trim() || null,
        verify_text: form.verify_text.trim() || null,
      };
      // Omitted on an edit that did not re-paste, so "leave the blob alone" is
      // expressible — the one thing a user must be able to do while renaming.
      if (form.storage_state.trim()) body.storage_state = form.storage_state.trim();
      const path = form.id
        ? `/api/projects/${projectId}/sessions/${form.id}`
        : `/api/projects/${projectId}/sessions`;
      await api(path, { token, method: form.id ? 'PUT' : 'POST', body });
      setEditing(null);
      // `onChanged` as well as `load`: the count on the tab that leads here
      // belongs to the project, and a stale one is a wrong signpost.
      await Promise.all([load(), onChanged?.()]);
    } catch (err) {
      setError(`Save: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(session) {
    if (
      !window.confirm(
        `Delete ${session.name}? Tests using it will keep running, but they will start signed out.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/sessions/${session.id}`, { token, method: 'DELETE' });
      await Promise.all([load(), onChanged?.()]);
    } catch (err) {
      setError(`Delete: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && (
        <div className="error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {sessions.length === 0 ? (
        <EmptyState icon={KeyRound} title="No saved sessions">
          Save a signed-in browser session and this project's tests can start already logged in —
          no login steps, no tokens spent on them. The usual way: write a test that logs in, add a
          session here that points at it, and its next passing run fills the session (put that test
          on a nightly schedule and it never goes stale). If you already have a Playwright{' '}
          <code>storageState.json</code>, paste that instead. Either way it is stored encrypted and
          can never be read back.
        </EmptyState>
      ) : (
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="row-main">
                <span className="row-name">{s.name}</span>
                <span className="row-sub">
                  {s.captured_at ? (
                    <>
                      {s.cookie_count} cookie{s.cookie_count === 1 ? '' : 's'}
                      {s.origin_count > 0 &&
                        `, ${s.origin_count} origin${s.origin_count === 1 ? '' : 's'}`}
                      {' · '}
                      {s.source === 'login_run' ? 'from a login run' : 'pasted'}{' '}
                      {capturedAgo(s.captured_at)}
                    </>
                  ) : (
                    // Said plainly, because a test opting into this one is
                    // refused at run start rather than run signed out — the
                    // user should hear it here first.
                    'Not captured yet — the next passing run of its login test will fill it'
                  )}
                </span>
              </span>
              <span className="row-actions">
                <IconButton
                  icon={RefreshCw}
                  label="Replace or edit"
                  onClick={() => setEditing(toForm(s))}
                />
                <IconButton icon={Trash2} label="Delete" onClick={() => remove(s)} disabled={busy} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="add-form">
        <Button icon={Plus} onClick={() => setEditing(toForm(null))} disabled={busy}>
          Add a session
        </Button>
      </div>

      {editing && (
        <SessionEditor
          form={editing}
          setForm={setEditing}
          tests={tests}
          busy={busy}
          onSave={() => save(editing)}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function toForm(session) {
  return {
    id: session?.id || null,
    name: session?.name || '',
    storage_state: '',
    login_test_id: session?.login_test_id || '',
    verify_url_contains: session?.verify_url_contains || '',
    verify_text: session?.verify_text || '',
  };
}

function SessionEditor({ form, setForm, tests, busy, onSave, onClose }) {
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  // A new session needs SOME way to be filled — a pasted blob, or the login
  // test that will capture one. Requiring the paste would make Playwright a
  // prerequisite for the path that exists so you never need it.
  const canSave =
    form.name.trim() && (form.id || form.storage_state.trim() || form.login_test_id);

  return (
    <Modal
      title={form.id ? `Edit ${form.name}` : 'Add a session'}
      description="Tests in this project can opt into a session and start already signed in."
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={onSave} disabled={busy || !canSave}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        <input value={form.name} onChange={set('name')} placeholder="staging login" autoFocus />
      </Field>

      <Field
        label={form.id ? 'Replace the session (optional)' : 'Paste a storageState.json (optional)'}
        hint={
          form.id
            ? 'Leave empty to keep the stored session. Pasting replaces it.'
            : 'Only if you already have one from Playwright. Otherwise leave this empty and pick a login test below — that run will capture the session for you.'
        }
      >
        <textarea
          value={form.storage_state}
          onChange={set('storage_state')}
          rows={6}
          spellCheck={false}
          placeholder='{"cookies": [...], "origins": [...]}'
        />
      </Field>

      <Field
        label="Refreshed by"
        hint="A test whose job is to log in. Every passing run of it saves the browser's session here — point a nightly schedule at it and the session never goes stale."
      >
        <select value={form.login_test_id} onChange={set('login_test_id')}>
          <option value="">Nothing — this session is only ever pasted</option>
          {tests.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Signed-in check (optional)"
        hint="Checked before the first step, so a session that has expired says so instead of failing the goal twenty steps later. Both are matched if both are given."
      >
        <input
          value={form.verify_url_contains}
          onChange={set('verify_url_contains')}
          placeholder="URL contains, e.g. /dashboard"
        />
        <input
          value={form.verify_text}
          onChange={set('verify_text')}
          placeholder="Page shows, e.g. Sign out"
        />
      </Field>
    </Modal>
  );
}

// Coarse on purpose: what a user needs from this number is "is it fresh", and
// an exact timestamp invites reading precision into a cookie's lifetime that
// nobody can act on.
function capturedAgo(at) {
  if (!at) return '';
  const days = Math.floor((Date.now() - new Date(at).getTime()) / 86400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}
