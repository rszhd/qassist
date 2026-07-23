import { useEffect, useState } from 'react';
import { AlertTriangle, MailX } from 'lucide-react';
import { api } from './api.js';
import { Button, Field, Modal } from './ui.jsx';

// Who hears about this project's runs, and when (US-012). Prefs live on the
// project rather than on each test, so this dialog is the whole feature's UI:
// a mode and a recipient list, saved with the project itself.
//
// Addresses are one per line rather than a chip editor — the server already
// validates and de-duplicates the list, and a textarea is what a person pastes
// a team's addresses into.
const MODES = [
  ['failure', 'Only when a run does not pass'],
  ['always', 'Every finished run'],
  ['never', 'Never'],
];

const linesOf = (emails) => (emails || []).join('\n');
const parse = (text) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

export default function NotifyPrefs({ project, token, mailEnabled, onClose, onSaved }) {
  const [mode, setMode] = useState(project.notify || 'failure');
  const [text, setText] = useState(linesOf(project.notify_emails));
  const [suppressed, setSuppressed] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // An unsubscribed address stays in the list and silently gets nothing, so
  // the dialog that owns the list is where that has to be visible.
  const loadSuppressions = () =>
    api('/api/notifications/suppressions', { token })
      .then(({ suppressions }) => setSuppressed(suppressions.map((s) => s.email)))
      .catch(() => {});

  useEffect(() => {
    loadSuppressions();
  }, [token]);

  const recipients = parse(text);
  const optedOut = recipients.filter((e) => suppressed.includes(e.toLowerCase()));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api(`/api/projects/${project.id}`, {
        token,
        method: 'PUT',
        body: { notify: mode, notify_emails: recipients },
      });
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function resubscribe(email) {
    setError(null);
    try {
      await api(`/api/notifications/suppressions/${encodeURIComponent(email)}`, {
        token,
        method: 'DELETE',
      });
      await loadSuppressions();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Modal
      title={`Notifications for ${project.name}`}
      description="Emailed when a run of this project's tests finishes — with the PDF report attached."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {!mailEnabled && (
        <div className="banner">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            <strong>Email is not configured</strong>
            <span>
              No <code>RESEND_API_KEY</code> / <code>MAIL_FROM</code> on the server. These prefs
              save, but nothing is sent until they are set.
            </span>
          </span>
        </div>
      )}

      {error && (
        <div className="error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <Field label="Send email" hint="Errors and unjudged runs count as “does not pass”.">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          {MODES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Recipients"
        hint="One address per line. Leave empty to fall back to the server's NOTIFY_EMAILS."
      >
        <textarea
          rows={4}
          value={text}
          placeholder="qa@example.com"
          onChange={(e) => setText(e.target.value)}
        />
      </Field>

      {optedOut.map((email) => (
        <p className="hint opted-out" key={email}>
          <MailX size={13} aria-hidden="true" />
          <span>
            <code>{email}</code> unsubscribed and will be skipped.
          </span>
          <Button size="sm" className="spacer" onClick={() => resubscribe(email)}>
            Re-enable
          </Button>
        </p>
      ))}
    </Modal>
  );
}
