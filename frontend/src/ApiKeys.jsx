import { useEffect, useState } from 'react';
import { Check, Copy, Plus } from 'lucide-react';
import { Button, IconButton } from './ui.jsx';
import { api } from './api.js';
import { formatWhen } from './status.js';

// Per-user API keys (US-021): the bearer tokens CI (US-008) sends. Shown only
// in multi-user mode — a single-token / open instance uses WORKER_API_TOKEN and
// has no per-user keys. The plaintext exists once, in the create response, so
// `fresh` holds it until the user copies it and moves on; a reload can never
// bring it back.
export default function ApiKeys() {
  const [keys, setKeys] = useState(null);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = () =>
    api('/api/keys')
      .then((d) => setKeys(d.keys))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const key = await api('/api/keys', { method: 'POST', body: { label: label.trim() } });
      setFresh(key);
      setCopied(false);
      setLabel('');
      setKeys((prev) => [key, ...(prev || [])]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id) {
    setError(null);
    try {
      await api(`/api/keys/${id}/revoke`, { method: 'POST' });
      if (fresh?.id === id) setFresh(null);
      setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, revoked_at: new Date().toISOString() } : k)));
    } catch (e) {
      setError(e.message);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(fresh.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const active = (keys || []).filter((k) => !k.revoked_at);

  return (
    <div className="api-keys">
      <div className="field-label">API keys</div>
      <p className="field-hint">
        Bearer tokens for CI and scripts. A key carries your access — treat it like a password.
      </p>

      <form className="api-key-new" onSubmit={create}>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name this key, e.g. CI pipeline"
          aria-label="Key name"
          maxLength={120}
        />
        <Button icon={Plus} type="submit" disabled={busy}>
          New key
        </Button>
      </form>

      {fresh && (
        <div className="api-key-fresh">
          <p className="hint">Copy this now — it is shown only once.</p>
          <div className="api-key-reveal">
            <code>{fresh.token}</code>
            <IconButton icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy key'} onClick={copy} />
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {keys && active.length === 0 && <p className="field-hint">No keys yet.</p>}
      {active.length > 0 && (
        <ul className="api-key-list">
          {active.map((k) => (
            <li key={k.id}>
              <div className="api-key-meta">
                <span className="api-key-label">{k.label || 'Unlabeled key'}</span>
                <span className="api-key-when">
                  Created {formatWhen(k.created_at)}
                  {k.last_used_at ? ` · last used ${formatWhen(k.last_used_at)}` : ' · never used'}
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => revoke(k.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
