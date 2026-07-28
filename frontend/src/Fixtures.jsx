import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Paperclip, Trash2, Upload } from 'lucide-react';
import { api, uploadFixture } from './api.js';
import { Button, EmptyState, IconButton } from './ui.jsx';

// Project fixtures (US-048): the files this project's tests may attach. Set up
// once by the team, like a variable — which is why they live here in Projects
// and not on an individual test.
//
// A fixture is referred to from a goal by its filename ("upload cv.pdf and
// submit"), so the filename is the only identifier shown. There is deliberately
// no rename: the goal text points at the name, and renaming underneath it would
// break a saved test silently.
export default function Fixtures({ projectId, token, onChanged }) {
  const [fixtures, setFixtures] = useState([]);
  const [quota, setQuota] = useState({ used: 0, total: 0, max: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/projects/${projectId}/fixtures`, { token });
      setFixtures(data.fixtures);
      setQuota({ used: data.used_bytes, total: data.quota_bytes, max: data.max_bytes });
    } catch (err) {
      setError(`Files: ${err.message}`);
    }
  }, [projectId, token]);

  useEffect(() => {
    load();
  }, [load]);

  async function mutate(label, fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // `onChanged` as well as `load`: the count on the tab that leads here
      // belongs to the project, and a stale one is a wrong signpost.
      await Promise.all([load(), onChanged?.()]);
    } catch (err) {
      setError(`${label}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function onPick(e) {
    const file = e.target.files?.[0];
    // Cleared straight away so picking the same file twice in a row still fires
    // a change event — the obvious thing to do after a failed upload.
    e.target.value = '';
    if (!file) return;
    mutate('Upload', () => uploadFixture(projectId, file, token));
  }

  function remove(fixture) {
    if (!window.confirm(`Delete ${fixture.filename}? Tests that name it will stop working.`)) return;
    mutate('Delete', () =>
      api(`/api/projects/${projectId}/fixtures/${encodeURIComponent(fixture.filename)}`, {
        token,
        method: 'DELETE',
      })
    );
  }

  return (
    <>
      {error && (
        <div className="error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {fixtures.length === 0 ? (
        <EmptyState icon={Paperclip} title="No files yet">
          Upload a file here and any test in this project can attach it — name it in the goal, as
          in "upload cv.pdf and submit". A run can only ever attach this project's files.
        </EmptyState>
      ) : (
        <ul className="list">
          {fixtures.map((f) => (
            <li key={f.id}>
              <span className="row-main">
                <span className="row-name">{f.filename}</span>
                <span className="row-sub">{formatBytes(f.size_bytes)}</span>
              </span>
              <span className="row-actions">
                <IconButton icon={Trash2} label="Delete" onClick={() => remove(f)} disabled={busy} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="add-form">
        <input type="file" ref={fileInput} onChange={onPick} hidden />
        <Button icon={Upload} onClick={() => fileInput.current?.click()} disabled={busy}>
          Upload a file
        </Button>
        <span className="row-sub quota">
          {formatBytes(quota.used)} of {formatBytes(quota.total)} used, up to{' '}
          {formatBytes(quota.max)} each
        </span>
      </div>
    </>
  );
}

// Sizes a person reads, not a machine: whole KB below a megabyte, one decimal
// above it. Both caps are quoted through this so the empty state, the row and
// the refusal all say the number the same way.
function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  return `${Math.round((kb / 1024) * 10) / 10} MB`;
}
