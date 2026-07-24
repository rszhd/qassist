import { useEffect, useState } from 'react';
import { Button } from './ui.jsx';
import { api } from './api.js';
import { formatWhen } from './status.js';

// Bring-your-own OpenAI key (US-005): a per-user key the agent runs on, stored
// encrypted server-side. Shown only in multi-user mode. The value leaves the
// browser exactly once per save and is never read back — the UI only ever knows
// whether a key is stored and when it was set.
export default function OpenaiKey() {
  const [status, setStatus] = useState(null); // { set, updated_at }
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = () =>
    api('/api/account/openai-key')
      .then(setStatus)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/account/openai-key', { method: 'PUT', body: { key: value.trim() } });
      setValue('');
      setEditing(false);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError(null);
    try {
      await api('/api/account/openai-key', { method: 'DELETE' });
      setValue('');
      setEditing(false);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  const stored = status?.set;
  const showForm = editing || !stored;

  return (
    <div className="openai-key">
      <div className="field-label">OpenAI key</div>
      <p className="field-hint">
        Runs use your own OpenAI key, so the cost and rate limits are yours. It is stored encrypted and
        never shown again.
      </p>

      {stored && !editing && (
        <div className="openai-key-stored">
          <span>Key stored{status.updated_at ? ` · set ${formatWhen(status.updated_at)}` : ''}</span>
          <div className="openai-key-actions">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button variant="ghost" size="sm" onClick={remove}>
              Remove
            </Button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="openai-key-form">
          <input
            type="password"
            value={value}
            placeholder="sk-…"
            autoComplete="off"
            onChange={(e) => setValue(e.target.value)}
          />
          <div className="openai-key-actions">
            <Button variant="primary" size="sm" onClick={save} disabled={busy || !value.trim()}>
              Save
            </Button>
            {stored && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setValue('');
                  setError(null);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
