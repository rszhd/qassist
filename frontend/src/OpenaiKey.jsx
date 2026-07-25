import { useState } from 'react';
import { Button } from './ui.jsx';
import { api } from './api.js';
import { formatWhen } from './status.js';

// Bring-your-own OpenAI key (US-005): the key the agent runs on, stored
// encrypted server-side. Since US-039 it is the ONLY way a run is funded, so
// this renders in every mode with an agent — the solo self-hoster's key lands
// on the seeded operator the same way a tenant's lands on their row. The value
// leaves the browser exactly once per save and is never read back; App owns
// the { set, updated_at } status (the Run view's setup banner reads it too)
// and hands it down with the reload that keeps both in step.
export default function OpenaiKey({ token, status, onReload }) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/account/openai-key', { token, method: 'PUT', body: { key: value.trim() } });
      setValue('');
      setEditing(false);
      onReload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError(null);
    try {
      await api('/api/account/openai-key', { token, method: 'DELETE' });
      setValue('');
      setEditing(false);
      onReload();
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
