import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, Plus, Puzzle, RefreshCw, Trash2 } from 'lucide-react';
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
  const [captureSetup, setCaptureSetup] = useState(null);
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
      if (!form.id && form.captureMethod === 'extension') body.capture_method = 'extension';
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

  // Mints a one-time capture token (US-063) and hands the setup code to the
  // modal below. Any session can be (re-)captured this way regardless of
  // `source` — the same "replace it" freedom the paste route already has.
  async function startExtensionCapture(session) {
    setError(null);
    try {
      const setup = await api(`/api/projects/${projectId}/sessions/${session.id}/capture-token`, {
        token,
        method: 'POST',
      });
      setCaptureSetup({ ...setup, sessionName: session.name });
    } catch (err) {
      setError(`Capture token: ${err.message}`);
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
          no login steps, no tokens spent on them. Add one, point it at a test that logs in, and
          its next passing run fills the session. Stored encrypted; never read back.
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
                      {s.source === 'login_run'
                        ? 'from a login run'
                        : s.source === 'extension'
                          ? 'captured via extension'
                          : 'pasted'}{' '}
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
                <IconButton
                  icon={Puzzle}
                  label="Capture with browser extension"
                  onClick={() => startExtensionCapture(s)}
                  disabled={busy}
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

      {captureSetup && (
        <CaptureSetupModal setup={captureSetup} onClose={() => setCaptureSetup(null)} />
      )}
    </>
  );
}

// Shows the one-time setup code a browser extension trades for permission to
// fill this session (US-063). The token lives only in `captureSetup` state —
// closing the modal drops it from memory the same way ApiKeys.jsx's `fresh`
// key is never persisted, and a re-open mints a new one rather than
// resurfacing the old.
function CaptureSetupModal({ setup, onClose }) {
  const [copied, setCopied] = useState(false);
  const code = toSetupCode(setup);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal
      title={`Capture "${setup.sessionName}" with the extension`}
      description="Open the QAssist browser extension, paste this setup code, name the site to capture, and confirm."
      onClose={onClose}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="api-key-fresh">
        <p className="hint">One-time code — copy it now. It expires in 15 minutes or on first use.</p>
        <div className="api-key-reveal">
          <code>{code}</code>
          <IconButton icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy code'} onClick={copy} />
        </div>
      </div>
    </Modal>
  );
}

// `{token, instance_url}` as one pasteable string, so a user hands the
// extension a single blob instead of typing a LAN address by hand.
function toSetupCode({ token, instance_url }) {
  const json = JSON.stringify({ token, instance_url });
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toForm(session) {
  return {
    id: session?.id || null,
    name: session?.name || '',
    storage_state: '',
    login_test_id: session?.login_test_id || '',
    verify_url_contains: session?.verify_url_contains || '',
    verify_text: session?.verify_text || '',
    // Create-only (US-063): "the extension will fill this later" satisfies
    // the same "some way to be filled" guard a login test or a paste does.
    captureMethod: '',
  };
}

function SessionEditor({ form, setForm, tests, busy, onSave, onClose }) {
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  // A new session needs SOME way to be filled — a pasted blob, the login test
  // that will capture one, or the browser extension for the logins a test can
  // never drive (social login). Requiring the paste would make Playwright a
  // prerequisite for the path that exists so you never need it.
  const canSave =
    form.name.trim() &&
    (form.id || form.storage_state.trim() || form.login_test_id || form.captureMethod === 'extension');

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

      {form.id && (
        <Field
          label="Replace the session (optional)"
          hint="Leave empty to keep the stored session. Pasting replaces it."
        >
          <textarea
            value={form.storage_state}
            onChange={set('storage_state')}
            rows={6}
            spellCheck={false}
            placeholder='{"cookies": [...], "origins": [...]}'
          />
        </Field>
      )}

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

      {!form.id && (
        <Field
          label="Or capture with the browser extension"
          hint="For logins a test can never drive — Google, Microsoft, any social login. Create the session empty, then use the extension in your own browser to fill it."
        >
          <label className="var-flag">
            <input
              type="checkbox"
              checked={form.captureMethod === 'extension'}
              onChange={(e) =>
                setForm({ ...form, captureMethod: e.target.checked ? 'extension' : '' })
              }
            />
            Capture later using the browser extension
          </label>
        </Field>
      )}

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
