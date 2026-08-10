// @ts-check
// Saved tests (US-009): CRUD + one-click run. A saved test is the reusable
// unit (goal + start_url + settings); running one denormalizes those fields
// into the runs row so history survives edits/deletes.
import express from 'express';
import { db, currentUserId, isUuid } from '../db.js';
import { createRun } from '../runs.js';
import { DEFAULT_MAX_STEPS } from '../config.js';
import {
  h, requireDb, requireAgentKey, requireEntitled, withUserCap, respondOverCap,
  RUNNABLE_TEST_COLS, RUNNABLE_TEST_FROM, runnableFieldsFor,
} from './helpers.js';
import { previewMemory } from '../runs.js';
import { memoryOf } from '../testMemoryStore.js';
import {
  normalizeDeclarations, validateReferences, validateSecretTags, secretWrites,
} from '../variables.js';
import { applySecretWrites, withSecretState } from '../testSecrets.js';

/** @typedef {import('./helpers.js').AppRequest} AppRequest */

/**
 * Whether this edit stopped the test's notebook applying, and how much is at
 * stake (US-081).
 *
 * Reported by the server because the fingerprint is the server's: its two inputs
 * are *resolved*, and a client that hashed its own would be a second spelling
 * that agrees until it quietly does not. The count is here so the dialog can stay
 * silent when there is nothing to lose — most edits, and every test that has
 * learned nothing.
 *
 * Re-read through `RUNNABLE_TEST_COLS` rather than handed the row this write
 * returned: `COLS` is the test's own columns, and resolving a run needs the
 * project and session joins too. Cheap, and only on an edit.
 * @param {string} testId
 */
async function memoryAtStake(testId) {
  const stored = await memoryOf(testId);
  const lessons = Object.values(stored?.learned || {}).reduce(
    (total, section) => total + (Array.isArray(section) ? section.length : 0),
    0
  );
  if (!lessons) return { invalidated: false, lessons: 0 };
  const { rows } = await db().query(
    `select ${RUNNABLE_TEST_COLS} from ${RUNNABLE_TEST_FROM} where t.id = $1`,
    [testId]
  );
  const resolved = rows.length ? await runnableFieldsFor(rows[0]) : { error: 'not found' };
  if ('error' in resolved) return { invalidated: false, lessons };
  return {
    invalidated: previewMemory(resolved.fields).withheld === 'inputs_changed',
    lessons,
  };
}

// A stored secret's ciphertext is deliberately NOT reachable from here: it
// lives in `test_secrets` (US-064), which nothing that answers a request
// selects, so "it never leaves in a response" is a property of the schema
// rather than of remembering to mask at each of the four sites below. What each
// of those does add is `withSecretState` — the set/not-set flag, which is the
// only thing a secret ever tells a caller about its value.
const COLS =
  'id, name, goal, start_url, max_steps, model, variables, project_id, module_id, ' +
  'browser_session_id, created_at, updated_at';

/**
 * Resolve the grouping a write asks for (US-023 decision 4): when module_id is
 * set, project_id is derived from that module so a test can never sit in
 * module `auth` of project A while claiming project B. Returns
 * `{ error }`, or `{ projectId, moduleId }` where `undefined` means "leave
 * unchanged" and `null` means "clear". Grouping targets are scoped to `uid` so
 * a test can't be filed under another user's project or module.
 * @param {{ project_id?: string|null, module_id?: string|null }} body
 * @param {string|null} uid
 */
async function resolveGrouping(body, uid) {
  const { project_id, module_id } = body;
  if (module_id) {
    if (!isUuid(module_id)) return { error: 'unknown module_id' };
    const { rows } = await db().query(
      `select m.id, m.project_id from modules m
         join projects p on p.id = m.project_id
        where m.id = $1 and p.user_id = $2`,
      [module_id, uid]
    );
    if (!rows.length) return { error: 'unknown module_id' };
    return { projectId: rows[0].project_id, moduleId: rows[0].id };
  }
  // module_id explicitly cleared (null/'') → keep project_id, drop the module.
  const moduleId = module_id === undefined ? undefined : null;
  if (project_id === undefined) return { projectId: undefined, moduleId };
  if (project_id === null || project_id === '') return { projectId: null, moduleId: null };
  if (!isUuid(project_id)) return { error: 'unknown project_id' };
  const { rowCount } = await db().query('select 1 from projects where id = $1 and user_id = $2', [
    project_id,
    uid,
  ]);
  if (!rowCount) return { error: 'unknown project_id' };
  // Setting a project without naming a module always clears the module: the
  // old one may belong to a different project, and one predictable rule beats
  // a conditional that depends on the row's previous state.
  return { projectId: project_id, moduleId: null };
}

/**
 * Resolve the saved session a write opts into (US-043). Returns `{ error }`, or
 * `{ sessionId }` where `undefined` means "leave unchanged" and `null` clears.
 *
 * Scoped to the test's RESULTING project, not its current one: a write that
 * moves a test to another project while naming a session from the old one must
 * be refused, or the test runs with a credential its project does not own. And
 * refused rather than silently cleared — a test that quietly starts running
 * unauthenticated is a false green, which is the whole failure this story
 * exists to remove.
 * @param {{ browser_session_id?: string|null }} body
 * @param {string|null|undefined} projectId the project the test will be in
 */
async function resolveSession(body, projectId) {
  const raw = body.browser_session_id;
  if (raw === undefined) return { sessionId: undefined };
  if (raw === null || raw === '') return { sessionId: null };
  if (!isUuid(raw)) return { error: 'unknown browser_session_id' };
  if (!projectId) {
    return { error: 'a session belongs to a project — put this test in one first' };
  }
  const { rowCount } = await db().query(
    'select 1 from browser_sessions where id = $1 and project_id = $2',
    [raw, projectId]
  );
  if (!rowCount) return { error: "that session belongs to a different project" };
  return { sessionId: raw };
}

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function testsRouter({ checkToken }) {
  const r = express.Router();
  r.use(checkToken, requireDb);

  // ?project_id= / ?module_id= filter the list; project_id=none is the
  // Ungrouped bucket (US-023).
  r.get(
    '/',
    h(async (req, res) => {
      const { project_id, module_id } = req.query;
      const params = [currentUserId()];
      const where = ['user_id = $1'];
      if (project_id === 'none') where.push('project_id is null');
      else if (typeof project_id === 'string' && project_id) {
        if (!isUuid(project_id)) return res.status(400).json({ error: 'invalid project_id' });
        params.push(project_id);
        where.push(`project_id = $${params.length}`);
      }
      if (module_id === 'none') where.push('module_id is null');
      else if (typeof module_id === 'string' && module_id) {
        if (!isUuid(module_id)) return res.status(400).json({ error: 'invalid module_id' });
        params.push(module_id);
        where.push(`module_id = $${params.length}`);
      }
      const { rows } = await db().query(
        `select ${COLS} from tests where ${where.join(' and ')} order by created_at desc`,
        params
      );
      res.json({ tests: await withSecretState(rows) });
    })
  );

  r.post(
    '/',
    h(async (req, res) => {
      const { name, goal, start_url, max_steps, model, variables } = req.body || {};
      if (!name || !goal || !start_url) {
        return res.status(400).json({ error: 'name, goal and start_url are required' });
      }
      const decl = normalizeDeclarations(variables);
      if ('error' in decl) return res.status(400).json({ error: decl.error });
      // What the same array asks to do to the encrypted column, which is where
      // a secret's value goes — `decl.variables` has already had it blanked out
      // (US-064).
      const writes = secretWrites(variables);
      const refError = validateReferences(decl.variables, goal, start_url);
      if (refError) return res.status(400).json({ error: refError });
      const tagError = validateSecretTags({ goal, start_url });
      if (tagError) return res.status(400).json({ error: tagError });
      const group = await resolveGrouping(req.body || {}, currentUserId());
      if (group.error) return res.status(400).json({ error: group.error });
      const session = await resolveSession(req.body || {}, group.projectId);
      if (session.error) return res.status(400).json({ error: session.error });
      const { rows } = await db().query(
        `insert into tests (user_id, name, goal, start_url, max_steps, model, variables,
                            project_id, module_id, browser_session_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${COLS}`,
        [
          currentUserId(),
          name,
          goal,
          start_url,
          Number(max_steps) || DEFAULT_MAX_STEPS,
          model || null,
          JSON.stringify(decl.variables),
          group.projectId ?? null,
          group.moduleId ?? null,
          session.sessionId ?? null,
        ]
      );
      await applySecretWrites(rows[0].id, writes, decl.variables);
      res.status(201).json((await withSecretState(rows))[0]);
    })
  );

  r.get(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rows } = await db().query(`select ${COLS} from tests where id = $1 and user_id = $2`, [
        req.params.id,
        currentUserId(),
      ]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json((await withSecretState(rows))[0]);
    })
  );

  // Partial update: omitted fields keep their value; model '' clears to the
  // server default.
  r.put(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { name, goal, start_url, max_steps, model, variables } = req.body || {};
      const uid = currentUserId();
      const group = await resolveGrouping(req.body || {}, uid);
      if (group.error) return res.status(400).json({ error: group.error });
      // Variables and their {{name}} references validate against the *resulting*
      // row (US-035): an edit that drops a variable still referenced by the
      // unchanged goal must be rejected, so we resolve against current values
      // for whichever of the two the request omits. Scoped to the owner, so a
      // cross-user edit 404s here before the update runs.
      const current = await db().query(
        'select goal, start_url, variables, project_id from tests where id = $1 and user_id = $2',
        [req.params.id, uid]
      );
      if (!current.rows.length) return res.status(404).json({ error: 'not found' });
      // The project the test will be in once this write lands, which is what a
      // session is scoped against.
      const session = await resolveSession(
        req.body || {},
        group.projectId === undefined ? current.rows[0].project_id : group.projectId
      );
      if (session.error) return res.status(400).json({ error: session.error });
      const decl = variables === undefined
        ? { variables: current.rows[0].variables }
        : normalizeDeclarations(variables);
      if ('error' in decl) return res.status(400).json({ error: decl.error });
      const refError = validateReferences(
        decl.variables,
        goal ?? current.rows[0].goal,
        start_url ?? current.rows[0].start_url
      );
      if (refError) return res.status(400).json({ error: refError });
      // Merged, like the reference check above: a test saved before BUG-004 can
      // carry a literal placeholder, and it stays broken until the goal is fixed
      // — so an edit that leaves it in place is refused rather than blessed.
      const tagError = validateSecretTags({
        goal: goal ?? current.rows[0].goal,
        start_url: start_url ?? current.rows[0].start_url,
      });
      if (tagError) return res.status(400).json({ error: tagError });
      // $7/$9/$11 carry "was this field present at all?" so a null can mean
      // "clear it" rather than "leave it alone" — coalesce can't express that.
      const { rows } = await db().query(
        `update tests
            set name       = coalesce($2, name),
                goal       = coalesce($3, goal),
                start_url  = coalesce($4, start_url),
                max_steps  = coalesce($5, max_steps),
                model      = nullif(coalesce($6, model), ''),
                project_id = case when $7 then $8 else project_id end,
                module_id  = case when $9 then $10 else module_id end,
                variables  = case when $11 then $12 else variables end,
                browser_session_id = case when $13 then $14 else browser_session_id end,
                updated_at = now()
          where id = $1 and user_id = $15 returning ${COLS}`,
        [
          req.params.id,
          name ?? null,
          goal ?? null,
          start_url ?? null,
          max_steps != null ? Number(max_steps) : null,
          model ?? null,
          group.projectId !== undefined,
          group.projectId ?? null,
          group.moduleId !== undefined,
          group.moduleId ?? null,
          variables !== undefined,
          variables !== undefined ? JSON.stringify(decl.variables) : null,
          session.sessionId !== undefined,
          session.sessionId ?? null,
          uid,
        ]
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      // The same seam the declaration itself uses: `variables === undefined`
      // means "leave unchanged", and a stored secret has to obey that word for
      // word. Within a write that DOES carry the array, blank means keep —
      // TestDialog PUTs back the masked array it was given, so anything else
      // wipes a credential during a rename (US-064).
      if (variables !== undefined) {
        await applySecretWrites(req.params.id, secretWrites(variables), decl.variables);
      }
      res.json({
        ...(await withSecretState(rows))[0],
        memory: await memoryAtStake(req.params.id),
      });
    })
  );

  r.delete(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rowCount } = await db().query('delete from tests where id = $1 and user_id = $2', [
        req.params.id,
        currentUserId(),
      ]);
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      res.status(204).end();
    })
  );

  // One-click re-run. Optional start_url override lets CI point the saved
  // test at a fresh preview URL (US-008).
  r.post(
    '/:id/run',
    requireEntitled,
    requireAgentKey,
    withUserCap,
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      // RUNNABLE_TEST_COLS, not a list of this route's own. US-048 caught this
      // route building one and thereby missing the fixture whitelist join; the
      // fix then was to remember, which is not a fix. Sharing the fragment is:
      // everything a run needs off a test — the fence (US-042), the project
      // whose files it may attach (US-048), the session it starts with and the
      // preamble it runs (US-043) — arrives by construction.
      const { rows } = await db().query(
        `select ${RUNNABLE_TEST_COLS} from ${RUNNABLE_TEST_FROM}
          where t.id = $1 and t.user_id = $2`,
        [req.params.id, currentUserId()]
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      const test = rows[0];
      // Every resolution a run needs off the test — secrets, {{name}}
      // substitution, the session blob, the notebook — in the one spelling the
      // memory panel also reads, so the two can never disagree about what the
      // next run receives.
      const resolved = await runnableFieldsFor(
        test,
        /** @type {any} */ (req.body || {}),
        /** @type {AppRequest} */ (req).runOpenaiKey
      );
      if ('error' in resolved) return res.status(400).json({ error: resolved.error });
      const run = createRun(resolved.fields);
      if ('blocked' in run) return res.status(400).json({ error: run.error, reason: run.reason });
      if ('rejected' in run) return respondOverCap(res, run);
      res.json({ runId: run.id, testId: test.id, status: run.status });
    })
  );

  return r;
}
