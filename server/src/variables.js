// @ts-check
// US-035: per-run variables. A saved test declares named variables; the goal
// and start_url reference them as {{name}}. At run creation overrides (from the
// UI or a CI trigger body) are merged over the defaults and substituted in.
//
// This module is the pure logic — no DB, no spawn — so the resolution and the
// validation it turns into 400s are unit-testable in isolation. Two callers:
// the tests CRUD (declaration shape + reference validation) and the run engine
// (resolve + substitute at enqueue).
//
// Secret variables are the redaction-critical half (backlog/correctness-critical.md).
// Their real value must never enter the substituted goal/start_url or the
// `variables` map denormalized onto the persisted run — it leaves `resolveForRun`
// only on the separate `secrets` channel, which the run engine hands to the
// agent as `QA_VARS` (browser-use `sensitive_data`). The goal keeps a
// `<secret>name</secret>` placeholder — the same one US-034 already teaches the
// agent — so the browser substitutes the value at type-time, not the server.

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// Deliberately the same identifier grammar as NAME_RE so a reference can only
// name a declarable variable; whitespace inside the braces is tolerated.
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Validate and normalize a test's `variables` declaration array as it arrives
 * on create/update. Returns `{ error }` or `{ variables }` (the cleaned array,
 * ready to store as jsonb). `undefined` input normalizes to `[]`.
 * @param {unknown} raw
 * @returns {{ error: string } | { variables: Array<{name: string, value: string, secret: boolean, optional: boolean}> }}
 */
export function normalizeDeclarations(raw) {
  if (raw === undefined || raw === null) return { variables: [] };
  if (!Array.isArray(raw)) return { error: 'variables must be an array' };
  const seen = new Set();
  const variables = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return { error: 'each variable must be an object' };
    const { name, value, secret, optional } = /** @type {any} */ (entry);
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      return { error: `invalid variable name: ${JSON.stringify(name)}` };
    }
    if (seen.has(name)) return { error: `duplicate variable name: ${name}` };
    seen.add(name);
    if (value !== undefined && typeof value !== 'string') {
      return { error: `variable ${name}: value must be a string` };
    }
    if (secret !== undefined && typeof secret !== 'boolean') {
      return { error: `variable ${name}: secret must be a boolean` };
    }
    if (optional !== undefined && typeof optional !== 'boolean') {
      return { error: `variable ${name}: optional must be a boolean` };
    }
    variables.push({
      name,
      value: value ?? '',
      secret: secret ?? false,
      optional: optional ?? false,
    });
  }
  return { variables };
}

/**
 * The distinct `{{name}}` names referenced across the given texts.
 * @param {...(string|null|undefined)} texts
 * @returns {Set<string>}
 */
export function referencedNames(...texts) {
  const names = new Set();
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const m of text.matchAll(PLACEHOLDER)) names.add(m[1]);
  }
  return names;
}

/**
 * Create-time check: every `{{name}}` in the goal/start_url must be declared
 * (US-035 decision — reject at save; a silent literal is a false-green risk).
 * @param {Array<{name: string}>} variables
 * @param {...(string|null|undefined)} texts
 * @returns {string | null} error message, or null when every reference resolves
 */
export function validateReferences(variables, ...texts) {
  const declared = new Set(variables.map((v) => v.name));
  for (const name of referencedNames(...texts)) {
    if (!declared.has(name)) return `goal references undefined variable {{${name}}}`;
  }
  return null;
}

/**
 * Resolve a run's variables: overrides merged over the test's defaults, then
 * substituted into goal/start_url. Returns `{ error }` (→ 400) or the resolved
 * `{ goal, start_url, variables, secrets }`. `variables` is the map denormalized
 * onto the run for history — non-secret values in full, a secret as the
 * presence marker `'<secret>'` (never its value). `secrets` is the real
 * name→value map of *referenced* secrets, routed to the agent as `QA_VARS` and
 * never persisted. A secret's `{{name}}` becomes a `<secret>name</secret>`
 * placeholder in the goal; a secret referenced in start_url is rejected (a
 * secret in a URL is the exact leak US-034's scrub exists to patch). Overrides
 * naming a variable this test doesn't declare are ignored — a group override
 * sprays every member test and each fills only the names it knows (US-035 group
 * semantics).
 * @param {{ variables?: Array<{name: string, value: string, secret: boolean, optional: boolean}>,
 *          overrides?: Record<string, string> | null, goal: string, start_url: string }} input
 * @returns {{ error: string } | { goal: string, start_url: string, variables: Record<string, string>, secrets: Record<string, string> }}
 */
export function resolveForRun({ variables = [], overrides, goal, start_url }) {
  const usedInUrl = referencedNames(start_url);
  const used = referencedNames(goal, start_url);
  const resolved = {};
  const secrets = {};
  const subMap = {};
  for (const v of variables) {
    const override = overrides && Object.prototype.hasOwnProperty.call(overrides, v.name)
      ? overrides[v.name]
      : undefined;
    const value = override ?? v.value;
    if (v.secret) {
      if (usedInUrl.has(v.name)) {
        return { error: `secret variable ${v.name} cannot appear in start_url` };
      }
      resolved[v.name] = '<secret>';
      if (used.has(v.name)) {
        if (!v.optional && !value) return { error: `variable ${v.name} is required` };
        secrets[v.name] = value;
        subMap[v.name] = `<secret>${v.name}</secret>`;
      }
      continue;
    }
    if (used.has(v.name) && !v.optional && !value) {
      return { error: `variable ${v.name} is required` };
    }
    resolved[v.name] = value;
    subMap[v.name] = value;
  }
  const sub = (text) => text.replace(PLACEHOLDER, (whole, name) =>
    Object.prototype.hasOwnProperty.call(subMap, name) ? subMap[name] : whole
  );
  return { goal: sub(goal), start_url: sub(start_url), variables: resolved, secrets };
}
