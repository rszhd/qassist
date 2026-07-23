// Thin fetch wrapper for the control-plane API: attaches the bearer token,
// unwraps the server's `{ error }` shape into a throwable message.
export async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const err = new Error(payload.error || `HTTP ${res.status}`);
    // Callers that treat one code differently (the run page's 404 is "no such
    // run", not "something broke") shouldn't have to match on the message.
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Open a run's PDF in a new tab. The report renders just after the run
 * finishes, so a 202 means "not yet" rather than an error — poll through it.
 * Fetched as a blob, not linked directly, because the endpoint needs the
 * bearer header (unlike /recording, which a <video> loads by URL).
 */
export async function openReport(runId, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  for (let i = 0; i < 15; i++) {
    const res = await fetch(`/api/runs/${runId}/report.pdf`, { headers });
    if (res.status === 202) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.open(URL.createObjectURL(await res.blob()), '_blank');
    return;
  }
  throw new Error('report still generating — try again in a moment');
}
