import { useEffect, useState } from 'react';
import { api } from './api.js';

// Same identifier grammar the server matches on (server/src/variables.js).
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** The distinct `{{name}}` names a text references. */
export function referencedNames(text) {
  return new Set([...String(text ?? '').matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
}

/**
 * Fill a saved test's `{{name}}` placeholders for the stage display only — the
 * server does the authoritative substitution. Overrides win over each
 * variable's default; an unknown name is left as-is (the server would 400 it).
 * A secret is shown as the `<secret>name</secret>` placeholder, never its value
 * — the same masking the server applies, so a password never lands in the goal
 * textarea (US-035 secret path).
 */
export function fillTemplate(text, variables, overrides) {
  const values = {};
  const secret = new Set();
  for (const v of variables || []) {
    values[v.name] = v.value;
    if (v.secret) secret.add(v.name);
  }
  if (overrides) Object.assign(values, overrides);
  return String(text ?? '').replace(PLACEHOLDER_RE, (whole, name) => {
    if (secret.has(name)) return `<secret>${name}</secret>`;
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole;
  });
}

/**
 * What a module or suite run actually did with its tests. The server starts as
 * many as the concurrency cap allows and queues the rest, so on a busy worker
 * "the rest run in the background" is only half the truth (US-027).
 */
export function batchSummary({ total, queued }) {
  const tests = `${total} test${total === 1 ? '' : 's'}`;
  if (total === 1) return `${tests}, running below.`;
  if (queued > 0) return `${tests}. Following the first below; ${queued} wait for a free slot.`;
  return `${tests}. Following the first below; the rest run in the background.`;
}

/**
 * Rows from `url` (null = nothing to fetch), unwrapped from `res[key]` and
 * refetched whenever the url or `tick` changes. Deliberately uncached: these
 * lists are small, and refetching is what keeps the Run view in step with
 * edits made in Projects.
 */
export function useProjectList(url, key, token, onError, tick) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!url) {
      setRows([]);
      return;
    }
    let cancelled = false;
    api(url, { token })
      .then((res) => !cancelled && setRows(res[key]))
      .catch((err) => !cancelled && onError(`${key}: ${err.message}`));
    return () => {
      cancelled = true;
    };
  }, [url, key, token, onError, tick]);
  return rows;
}
