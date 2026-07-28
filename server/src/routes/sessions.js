// @ts-check
// Saved browser sessions over HTTP (US-043). Handlers rather than a router, and
// mounted on `routes/projects.js`'s own router for the reason routes/fixtures.js
// gives: the `r.param('project')` resolver is what scopes every one of them to
// the calling tenant, and a sub-router could be mounted somewhere that skips it.
//
// The rule this file exists to keep: NOTHING HERE EVER RETURNS THE BLOB. A
// storageState is the credential, so the read surface is deliberately built out
// of the things that let a user tell a live session from a stale one — a name,
// the counts, when it was captured — and nothing that lets them read it back.
// `SESSION_COLS` is the whole of it, and there is no route that selects more.
import { db, isUuid } from '../db.js';
import { encryptSecret } from '../crypto.js';
import { normalizeStorageState, sessionKey } from '../browserSession.js';
import { isUniqueViolation } from './helpers.js';

// Everything a session is allowed to say about itself. `storage_state_ciphertext`
// is absent by construction: this fragment is the only column list any query in
// this file uses, so there is no `select *` for the blob to arrive on.
const SESSION_COLS =
  'id, project_id, name, cookie_count, origin_count, source, login_test_id, ' +
  'verify_url_contains, verify_text, captured_at, created_at, updated_at';

/** GET /api/projects/:project/sessions */
export async function listSessions(req, res) {
  const project = /** @type {any} */ (req).project;
  const { rows } = await db().query(
    `select ${SESSION_COLS} from browser_sessions where project_id = $1 order by name`,
    [project.id]
  );
  res.json({ sessions: rows });
}

/**
 * POST /api/projects/:project/sessions — both routes to a session (AC #2).
 *
 * `storage_state` is OPTIONAL, and that is the whole point. Requiring it would
 * make pasting a Playwright `storageState.json` a prerequisite for the
 * login-run path, which is backwards: the login run is the product and the
 * paste is the escape hatch for teams who already have the file. Somebody who
 * has never touched Playwright names a session, points it at the test that logs
 * in, and the first passing run of that test fills it.
 *
 * What is required instead is that a session have SOME way to be filled: no
 * blob and no login test is a row that can never hold anything, and the useful
 * moment to say so is now rather than when a run refuses.
 */
export async function createSession(req, res) {
  const project = /** @type {any} */ (req).project;
  const body = /** @type {any} */ (req.body || {});
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'a name is required' });

  const pasted = body.storage_state !== undefined && body.storage_state !== null
    && body.storage_state !== '';
  /** @type {{ storageState: string, cookies: number, origins: number } | null} */
  let state = null;
  if (pasted) {
    const normalized = normalizeStorageState(body.storage_state);
    if ('error' in normalized) return res.status(400).json({ error: normalized.error });
    state = normalized;
  }

  const login = await resolveLoginTest(body.login_test_id, project.id);
  if ('error' in login) return res.status(400).json({ error: login.error });
  if (!pasted && !login.testId) {
    return res.status(400).json({
      error:
        'a session needs either a pasted storage state or a login test to capture one — ' +
        'pick the test that logs in, and its next passing run will fill this session',
    });
  }
  const verify = resolveVerify(body);
  if ('error' in verify) return res.status(400).json({ error: verify.error });

  try {
    const { rows } = await db().query(
      `insert into browser_sessions
         (project_id, name, name_key, storage_state_ciphertext, cookie_count, origin_count,
          captured_at, source, login_test_id, verify_url_contains, verify_text)
       values ($1, $2, $3, $4, $5, $6, $7, 'pasted', $8, $9, $10)
       returning ${SESSION_COLS}`,
      [
        project.id,
        name,
        sessionKey(name),
        state ? encryptSecret(state.storageState) : null,
        state ? state.cookies : 0,
        state ? state.origins : 0,
        // Null, not now(): "never captured" and "captured this second" must not
        // read the same on the row a user judges freshness from.
        state ? new Date() : null,
        login.testId ?? null,
        verify.urlContains ?? null,
        verify.text ?? null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({
        error: `this project already has a session called ${name} — rename or replace it`,
      });
    }
    throw err;
  }
}

/**
 * PUT /api/projects/:project/sessions/:id — rename, re-point, or re-paste.
 *
 * Re-pasting through the same route rather than a separate one: replacing a
 * stale blob is the single most common thing anyone will do here, and making it
 * a different verb would leave two ways to write the column.
 */
export async function updateSession(req, res) {
  const project = /** @type {any} */ (req).project;
  const id = req.params.id;
  if (!isUuid(id)) return res.status(404).json({ error: 'not found' });
  const body = /** @type {any} */ (req.body || {});

  const { rows: existing } = await db().query(
    'select id, storage_state_ciphertext from browser_sessions where id = $1 and project_id = $2',
    [id, project.id]
  );
  if (!existing.length) return res.status(404).json({ error: 'not found' });

  const sets = ['updated_at = now()'];
  const params = [id];
  const add = (sql, value) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };

  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'a name is required' });
    add('name', name);
    add('name_key', sessionKey(name));
  }
  if (body.storage_state !== undefined) {
    const state = normalizeStorageState(body.storage_state);
    if ('error' in state) return res.status(400).json({ error: state.error });
    add('storage_state_ciphertext', encryptSecret(state.storageState));
    add('cookie_count', state.cookies);
    add('origin_count', state.origins);
    add('source', 'pasted');
    sets.push('captured_at = now()');
  }
  if (body.login_test_id !== undefined) {
    const login = await resolveLoginTest(body.login_test_id, project.id);
    if ('error' in login) return res.status(400).json({ error: login.error });
    // Clearing the login test on a session that has never been captured leaves
    // a row nothing can ever fill. Refuse rather than let a user create the
    // dead end the create route already refuses.
    if (!login.testId && !existing[0].storage_state_ciphertext && body.storage_state === undefined) {
      return res.status(400).json({
        error:
          'this session has not been captured yet — clearing its login test would leave ' +
          'nothing able to fill it. Paste a storage state, or keep the login test.',
      });
    }
    add('login_test_id', login.testId ?? null);
  }
  const verify = resolveVerify(body);
  if ('error' in verify) return res.status(400).json({ error: verify.error });
  if (body.verify_url_contains !== undefined) add('verify_url_contains', verify.urlContains ?? null);
  if (body.verify_text !== undefined) add('verify_text', verify.text ?? null);

  try {
    const { rows } = await db().query(
      `update browser_sessions set ${sets.join(', ')} where id = $1 returning ${SESSION_COLS}`,
      params
    );
    res.json(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'this project already has a session with that name' });
    }
    throw err;
  }
}

/** DELETE /api/projects/:project/sessions/:id */
export async function deleteSession(req, res) {
  const project = /** @type {any} */ (req).project;
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const { rowCount } = await db().query(
    'delete from browser_sessions where id = $1 and project_id = $2',
    [req.params.id, project.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  // Member tests survive with `browser_session_id` nulled (015's `set null`):
  // deleting a credential must not delete the tests that used it, and a test
  // that now runs unauthenticated is visible in its own editor.
  res.status(204).end();
}

/**
 * The test whose passing run refreshes this session, scoped to the project.
 * `null`/`''` clears it. Refused rather than filtered when it names a test
 * outside the project — a login run that quietly refreshes nothing is the same
 * false green as a session that quietly authenticates nobody.
 */
async function resolveLoginTest(raw, projectId) {
  if (raw === null || raw === undefined || raw === '') return { testId: null };
  if (!isUuid(raw)) return { error: 'unknown login_test_id' };
  const { rowCount } = await db().query(
    'select 1 from tests where id = $1 and project_id = $2',
    [raw, projectId]
  );
  if (!rowCount) return { error: 'the login test must be a test in this project' };
  return { testId: raw };
}

/** How a run tells "still signed in" from "looking at a login page" (AC #4). */
function resolveVerify(body) {
  const urlContains = body.verify_url_contains;
  const text = body.verify_text;
  for (const [field, value] of [
    ['verify_url_contains', urlContains],
    ['verify_text', text],
  ]) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') return { error: `${field} must be a string` };
    if (value.length > 200) return { error: `${field} is too long` };
  }
  return {
    urlContains: urlContains ? String(urlContains).trim() : null,
    text: text ? String(text).trim() : null,
  };
}

