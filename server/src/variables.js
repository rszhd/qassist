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
//
// US-035 said that value is never persisted, and it held because someone was
// present to supply it. A schedule fires with nobody there, so US-064 amends
// the sentence rather than dropping it:
//
//   a secret's value is never persisted UNENCRYPTED, never returned by any
//   endpoint, and never denormalized onto a run.
//
// Everything given up is "never persisted at all"; the stored value lives
// encrypted in `test_secrets` (017), reaches this module as `stored` on the
// three paths that start a run, and never touches `tests.variables` — which is
// why `normalizeDeclarations` blanks a secret's value out of the declaration and
// `secretWrites` is the only thing that carries it anywhere.

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// Deliberately the same identifier grammar as NAME_RE so a reference can only
// name a declarable variable; whitespace inside the braces is tolerated.
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

// The secrets the *agent* puts in browser-use's `sensitive` dict itself, mid-run:
// the generated signup password when a mailbox is configured, the code/link
// get_email_code fetches, and the TOTP/SMS codes and SMS number US-059 added
// (run_agent.py). They are never declared on a test, so `{{name}}` cannot reach
// them — validateReferences would call them undeclared — and US-034's task
// text teaches the `<secret>name</secret>` spelling to anyone who reads a run's
// goal. So a hand-written literal is the only spelling they have, and
// BUG-004's rejection has to let these through.
// Kept in step with the agent by variables.test.js, which reads run_agent.py.
export const AGENT_PROVIDED_SECRETS = [
  'qa_password',
  'email_code',
  'email_link',
  'totp_code',
  'sms_number',
  'sms_code',
];

// The internal placeholder resolveForRun emits. Matching only well-formed tags
// with a legal name is the point: anything else that mentions `secret` as a tag
// is malformed, so it can't be exempt and can't be substituted either.
const SECRET_TAG = /<secret>([a-zA-Z_][a-zA-Z0-9_]*)<\/secret>/g;
const ANY_SECRET_TAG = /<\/?secret\b/i;

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
      // A secret's value never enters what is stored as jsonb (US-064). It
      // arrives on this same array — one editor, one PUT — so the split happens
      // here rather than being remembered at each write site, and a caller that
      // only knows the US-035 API cannot write plaintext by accident.
      // `secretWrites` is what carries it to the encrypted column.
      value: secret ? '' : value ?? '',
      secret: secret ?? false,
      optional: optional ?? false,
    });
  }
  return { variables };
}

/**
 * What a write asks to do to the *stored* values behind its secret
 * declarations. Three-state, because the field is never readable: a blank box
 * means keep what is stored, a non-empty one means replace it, and `clear`
 * means remove it.
 *
 * The first state is the one that matters. `TestDialog` loads the array a GET
 * returned — masked — and PUTs the whole thing back, so without "blank means
 * keep" a rename of the test wipes the credential, silently, and it surfaces as
 * a failed run at 02:00 a fortnight later.
 *
 * Pure and DB-free like the rest of this module: it says what should happen, and
 * `routes/tests.js` is what encrypts and writes.
 * @param {unknown} raw the incoming declaration array, before normalization
 * @returns {{ set: Record<string, string>, clear: string[] }}
 */
export function secretWrites(raw) {
  /** @type {Record<string, string>} */
  const set = {};
  /** @type {string[]} */
  const clear = [];
  if (!Array.isArray(raw)) return { set, clear };
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, value, secret } = /** @type {any} */ (entry);
    if (secret !== true || typeof name !== 'string' || !NAME_RE.test(name)) continue;
    // Both spellings at once is a client bug, and clear is the destructive
    // reading of it — obey that rather than storing a value someone asked to
    // remove.
    if (/** @type {any} */ (entry).clear) clear.push(name);
    else if (typeof value === 'string' && value) set[name] = value;
  }
  return { set, clear };
}

/**
 * The referenced, required secrets a test has nothing to resolve from — what a
 * schedule over it would fire into at 02:00 (US-064 option C).
 *
 * Answered from the *names* that have a stored value, so validating a schedule
 * decrypts nothing. The same rule `resolveForRun` applies below; the pairing is
 * asserted rather than assumed, because two spellings of "required and empty"
 * that drift apart give you a save the tick then refuses.
 * @param {{ variables?: Array<{name: string, value: string, secret: boolean, optional: boolean}>,
 *          storedNames?: string[], goal?: string|null, start_url?: string|null }} input
 * @returns {string[]}
 */
export function unresolvableSecrets({ variables = [], storedNames = [], goal, start_url }) {
  const used = referencedNames(goal, start_url);
  const have = new Set(storedNames);
  return variables
    .filter((v) => v.secret && !v.optional && used.has(v.name) && !v.value && !have.has(v.name))
    .map((v) => v.name);
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
 * Write-time check: a hand-written `<secret>name</secret>` is refused (BUG-004).
 * It is `resolveForRun`'s output, not its input — nothing declares it, so no
 * value is routed on the `secrets` channel and the placeholder text travels
 * into the task and gets typed into the page verbatim. Every layer behaves as
 * designed, which is why this can only be caught at save.
 *
 * The exception is `AGENT_PROVIDED_SECRETS` in a goal: those work today,
 * because the agent adds them to `sensitive` before the step that needs them.
 * `start_url` gets no exception — it is fetched before any of the three exists,
 * and "no secret placeholder in a URL" stays the absolute rule it is in
 * `resolveForRun`.
 * @param {{ goal?: string|null, start_url?: string|null }} texts
 * @returns {string | null} error message, or null when nothing internal leaked in
 */
export function validateSecretTags({ goal, start_url }) {
  if (typeof start_url === 'string' && ANY_SECRET_TAG.test(start_url)) {
    return 'start_url cannot contain a <secret> placeholder — a secret in a URL is the leak the placeholder exists to avoid';
  }
  if (typeof goal !== 'string') return null;
  const rest = goal.replace(SECRET_TAG, (whole, name) =>
    AGENT_PROVIDED_SECRETS.includes(name) ? '' : whole
  );
  for (const m of rest.matchAll(SECRET_TAG)) {
    return `goal uses <secret>${m[1]}</secret>, the internal form — it is sent to the browser literally. Write {{${m[1]}}} and declare ${m[1]} as a secret variable`;
  }
  if (ANY_SECRET_TAG.test(rest)) {
    return 'goal contains a <secret> tag — it is sent to the browser literally. Reference a secret variable as {{name}} instead';
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
 *
 * `stored` is the decrypted `test_secrets` map for this test (US-064), resolved
 * by the async caller before the synchronous run engine is entered — the same
 * shape `sessionsForTests` and the BYOK key already arrive in. Precedence is
 * override > stored > declaration, decided here because this is the one place
 * the manual, CI and scheduled paths already share.
 * @param {{ variables?: Array<{name: string, value: string, secret: boolean, optional: boolean}>,
 *          overrides?: Record<string, string> | null, stored?: Record<string, string> | null,
 *          goal: string, start_url: string }} input
 * @returns {{ error: string } | { goal: string, start_url: string, variables: Record<string, string>, secrets: Record<string, string> }}
 */
export function resolveForRun({ variables = [], overrides, stored, goal, start_url }) {
  const usedInUrl = referencedNames(start_url);
  const used = referencedNames(goal, start_url);
  const resolved = {};
  const secrets = {};
  const subMap = {};
  for (const v of variables) {
    const override = overrides && Object.prototype.hasOwnProperty.call(overrides, v.name)
      ? overrides[v.name]
      : undefined;
    if (v.secret) {
      if (usedInUrl.has(v.name)) {
        return { error: `secret variable ${v.name} cannot appear in start_url` };
      }
      // `||`, not `??`: an EMPTY override must not defeat a stored secret. The
      // override dialog prefills from the declaration — masked, so empty — and
      // sends every declared name, which means `''` arrives as a present key on
      // every manual run of a test that has one. Read as an override it would
      // break all of them, and there is nothing else `''` from a never-readable
      // box could usefully mean.
      const value = override || (stored && stored[v.name]) || v.value;
      if (!used.has(v.name)) {
        resolved[v.name] = '<secret>';
        continue;
      }
      if (!value) {
        if (!v.optional) return { error: `variable ${v.name} is required` };
        // An optional secret with nothing to resolve behaves like an empty
        // optional plain variable: no placeholder, nothing routed, and `''` in
        // history rather than the presence marker. Emitting the placeholder
        // with an empty value is what typed nothing into the password field and
        // reported the app as broken.
        resolved[v.name] = '';
        subMap[v.name] = '';
        continue;
      }
      resolved[v.name] = '<secret>';
      secrets[v.name] = value;
      subMap[v.name] = `<secret>${v.name}</secret>`;
      continue;
    }
    const value = override ?? v.value;
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
