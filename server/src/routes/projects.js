// @ts-check
// Projects (US-023): the top-level container for saved tests. A project holds
// modules (see routes/modules.js) and suites; both levels are optional on a
// test, so unassigned tests keep working and surface as "Ungrouped".
//
// Path params accept a uuid *or* a slug, so CI configs can read
// POST /api/projects/checkout/modules/auth/run (US-023 decision 8).
//
// The module-side query helpers live here because every one of them needs the
// project resolver; routes/modules.js imports them.
import express from 'express';
import { db, currentUserId, isUuid } from '../db.js';
import {
  h, requireDb, requireAgentKey, requireEntitled, withUserCap, runTestsFromRequest, slugify,
  RUNNABLE_TEST_COLS, RUNNABLE_TEST_FROM,
} from './helpers.js';
import { fixtureBody, listFixtures, uploadFixture, deleteFixture } from './fixtures.js';
import {
  listSessions, createSession, updateSession, deleteSession, mintSessionCaptureToken,
} from './sessions.js';
import { normalizePreamble } from '../browserSession.js';
import { removeProjectFixtures } from '../fixtures.js';
import { NOTIFY_MODES, cleanEmails } from '../notify.js';
import { validateAllowlist } from '../navigationPolicy.js';
import { instancePolicy } from '../config.js';

/** @typedef {import('./helpers.js').AppRequest} AppRequest */

export const PROJECT_COLS =
  'id, name, slug, notify, notify_emails, allowed_domains, initial_actions, created_at, updated_at';
export const MODULE_COLS = 'id, project_id, name, slug, created_at, updated_at';

/**
 * Resolve a :project param (uuid or slug) to its row, or null.
 * @param {string} ref
 */
async function findProject(ref) {
  const where = isUuid(ref) ? 'id = $2' : 'slug = $2';
  const { rows } = await db().query(
    `select ${PROJECT_COLS} from projects where user_id = $1 and ${where}`,
    [currentUserId(), ref]
  );
  return rows[0] || null;
}

/**
 * Resolve a :module param (uuid or slug) within a project, or null.
 * @param {string} projectId
 * @param {string} ref
 */
async function findModule(projectId, ref) {
  const where = isUuid(ref) ? 'id = $2' : 'slug = $2';
  const { rows } = await db().query(
    `select ${MODULE_COLS} from modules where project_id = $1 and ${where}`,
    [projectId, ref]
  );
  return rows[0] || null;
}

/** A module by id alone, for the flat /api/modules/:id routes. */
export async function findModuleById(id) {
  if (!isUuid(id)) return null;
  const { rows } = await db().query(
    `select m.${MODULE_COLS.split(', ').join(', m.')} from modules m
       join projects p on p.id = m.project_id
      where m.id = $1 and p.user_id = $2`,
    [id, currentUserId()]
  );
  return rows[0] || null;
}

/**
 * Test counts keyed by `column` (project_id or module_id). A grouped query
 * merged in JS rather than a correlated subquery per row: the counts are tiny,
 * and pg-mem (the test harness) can't resolve an outer alias inside a subquery.
 * @param {'project_id' | 'module_id'} column
 * @returns {Promise<Map<string, number>>}
 */
async function testCounts(column) {
  const { rows } = await db().query(
    `select ${column} as key, count(*)::int as n from tests
      where ${column} is not null group by ${column}`
  );
  return new Map(rows.map((r) => [r.key, r.n]));
}

// What a project holds, by table. The Projects view puts these on its tab
// strip, so they travel with the project rather than with each section: what a
// project holds is how you choose which section to open, and a count that only
// arrives once you are already there is too late to be navigation.
const PROJECT_COUNTS = [
  ['test_count', 'tests'],
  ['suite_count', 'suites'],
  ['session_count', 'browser_sessions'],
  ['fixture_count', 'fixtures'],
];

/**
 * The four counts above for one project. One query per table rather than four
 * scalar subqueries in a single select: pg-mem returns a scalar subquery as a
 * one-element array, so the compact form would be right only in production.
 * @param {string} projectId
 */
async function projectCounts(projectId) {
  const rows = await Promise.all(
    PROJECT_COUNTS.map(([, table]) =>
      // The table name is from the fixed list above, never from a request.
      db().query(`select count(*)::int as n from ${table} where project_id = $1`, [projectId])
    )
  );
  return Object.fromEntries(PROJECT_COUNTS.map(([key], i) => [key, rows[i].rows[0].n]));
}

/**
 * Modules with their test counts — one project's, or every project's when
 * `projectId` is null (which is what the flat /api/modules list asks for).
 * @param {string|null} [projectId]
 */
export async function listModules(projectId = null) {
  const { rows } = await db().query(
    `select m.${MODULE_COLS.split(', ').join(', m.')} from modules m
       join projects p on p.id = m.project_id
      where p.user_id = $1 ${projectId ? 'and m.project_id = $2' : ''}
      order by m.created_at`,
    projectId ? [currentUserId(), projectId] : [currentUserId()]
  );
  const counts = await testCounts('module_id');
  return rows.map((m) => ({ ...m, test_count: counts.get(m.id) || 0 }));
}

/**
 * Pick a slug that is free under `parent`, appending -2, -3, … on collision.
 * Falls back to 'item' when the name has no slug-able characters at all.
 * @param {'projects' | 'modules'} table
 * @param {'user_id' | 'project_id'} parentCol
 * @param {string} parentId
 * @param {string} name
 */
export async function uniqueSlug(table, parentCol, parentId, name) {
  const base = slugify(name) || 'item';
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const { rowCount } = await db().query(
      `select 1 from ${table} where ${parentCol} = $1 and slug = $2`,
      [parentId, candidate]
    );
    if (!rowCount) return candidate;
  }
}

/**
 * Validate a rename payload for a project or module. A slug is never derived
 * from a rename (US-023 decision 8) — change it deliberately or not at all,
 * because a rename silently breaking a CI config is the worse failure.
 * Returns `{ error }`, or `{ slug }` where null means "leave unchanged".
 * @param {{ slug?: string }} body
 * @param {{ slug: string }} current
 * @param {'projects' | 'modules'} table
 * @param {'user_id' | 'project_id'} parentCol
 * @param {string} parentId
 */
export async function resolveSlug(body, current, table, parentCol, parentId) {
  const { slug } = body;
  if (slug === undefined) return { slug: null };
  const next = slugify(slug);
  if (!next) return { error: 'slug must contain a letter or digit' };
  if (next !== current.slug) {
    const { rowCount } = await db().query(
      `select 1 from ${table} where ${parentCol} = $1 and slug = $2`,
      [parentId, next]
    );
    if (rowCount) return { error: 'slug is already taken' };
  }
  return { slug: next };
}

/**
 * Validate the notification prefs a write asks for (US-012). Returns
 * `{ error }`, or `{ mode, emails }` where `undefined` means "leave unchanged".
 * @param {{ notify?: string, notify_emails?: any }} body
 */
function resolveNotify(body) {
  const { notify, notify_emails } = body;
  if (notify !== undefined && !NOTIFY_MODES.has(notify)) {
    return { error: `notify must be one of ${[...NOTIFY_MODES].join(', ')}` };
  }
  if (notify_emails === undefined) return { mode: notify, emails: undefined };
  const cleaned = cleanEmails(notify_emails);
  if ('error' in cleaned) return { error: cleaned.error };
  return { mode: notify, emails: cleaned.emails };
}

/**
 * Validate the navigation allowlist a write asks for (US-042). Returns
 * `{ error }`, or `{ domains }` where `undefined` means "leave unchanged".
 *
 * The whole write is refused rather than filtered, deliberately: an operator
 * who is told "saved" must not later discover that the one entry that mattered
 * was dropped. `[]` is a legitimate value and means "no allowlist".
 * @param {{ allowed_domains?: any }} body
 */
function resolveAllowedDomains(body) {
  const { allowed_domains: domains } = body;
  if (domains === undefined) return { domains: undefined };
  const cleaned = Array.isArray(domains)
    ? domains.map((d) => (typeof d === 'string' ? d.trim() : d)).filter((d) => d !== '')
    : domains;
  const invalid = validateAllowlist(cleaned, instancePolicy());
  if (invalid) return { error: invalid.error };
  return { domains: /** @type {string[]} */ (cleaned) };
}

/**
 * Validate the per-project preamble a write asks for (US-043). Returns
 * `{ error }`, or `{ actions }` where `undefined` means "leave unchanged".
 *
 * Refused whole rather than filtered, like the allowlist above and for the same
 * reason — and note what the refusal covers: a preamble `navigate` is fenced
 * here, at WRITE time, against the same policy a start_url is judged by. A
 * preamble never passes through `createRun`'s fence, so without this it would
 * be a documented bypass of it.
 * @param {{ initial_actions?: any }} body
 */
function resolvePreamble(body) {
  const { initial_actions: raw } = body;
  if (raw === undefined) return { actions: undefined };
  const normalized = normalizePreamble(raw, instancePolicy());
  if ('error' in normalized) return { error: normalized.error };
  return { actions: normalized.actions };
}

/**
 * A `text[]` column's new value as SQL, or the column itself when the write
 * leaves it alone. Spelled out as an array literal over placeholders rather
 * than bound as one parameter: pg-mem (the test harness) has no array parameter
 * binding, and both lists are a handful of entries. Appends its values to
 * `params`.
 * @param {string} column
 * @param {string[] | undefined} values
 * @param {any[]} params
 */
function textArraySql(column, values, params) {
  if (values === undefined) return column;
  if (!values.length) return `'{}'::text[]`;
  const placeholders = values.map((_, i) => `$${params.length + i + 1}`).join(', ');
  params.push(...values);
  return `array[${placeholders}]::text[]`;
}

/** Start a run per member test of a module; `{ empty: true }` when it has none. */
export async function runModule(mod, body, openaiApiKey = null) {
  const { rows: tests } = await db().query(
    `select ${RUNNABLE_TEST_COLS} from ${RUNNABLE_TEST_FROM}
      where t.module_id = $1 order by t.created_at`,
    [mod.id]
  );
  if (!tests.length) return { empty: true };
  return { moduleId: mod.id, runs: await runTestsFromRequest(tests, body, openaiApiKey) };
}

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function projectsRouter({ checkToken }) {
  const r = express.Router();
  r.use(checkToken, requireDb);

  // Resolve :project once for every nested route.
  r.param(
    'project',
    /** @type {import('express').RequestParamHandler} */ (
      (req, res, next, ref) => {
        findProject(ref)
          .then((project) => {
            if (!project) return res.status(404).json({ error: 'not found' });
            /** @type {AppRequest} */ (req).project = project;
            next();
          })
          .catch(next);
      }
    )
  );

  r.get(
    '/',
    h(async (_req, res) => {
      const { rows } = await db().query(
        `select ${PROJECT_COLS} from projects where user_id = $1 order by created_at desc`,
        [currentUserId()]
      );
      const tests = await testCounts('project_id');
      const { rows: mods } = await db().query(
        'select project_id as key, count(*)::int as n from modules group by project_id'
      );
      const modules = new Map(mods.map((m) => [m.key, m.n]));
      res.json({
        projects: rows.map((p) => ({
          ...p,
          test_count: tests.get(p.id) || 0,
          module_count: modules.get(p.id) || 0,
        })),
      });
    })
  );

  r.post(
    '/',
    h(async (req, res) => {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      const userId = currentUserId();
      const slug = await uniqueSlug('projects', 'user_id', userId, name);
      const { rows } = await db().query(
        `insert into projects (user_id, name, slug) values ($1, $2, $3)
         returning ${PROJECT_COLS}`,
        [userId, name, slug]
      );
      res.status(201).json({ ...rows[0], test_count: 0, module_count: 0 });
    })
  );

  r.get(
    '/:project',
    h(async (req, res) => {
      // @ts-expect-error — set by r.param
      const project = req.project;
      const modules = await listModules(project.id);
      res.json({ ...project, modules, ...(await projectCounts(project.id)) });
    })
  );

  r.put(
    '/:project',
    h(async (req, res) => {
      // @ts-expect-error — set by r.param
      const project = req.project;
      const body = req.body || {};
      const slug = await resolveSlug(body, project, 'projects', 'user_id', currentUserId());
      if (slug.error) return res.status(400).json({ error: slug.error });
      const notify = resolveNotify(body);
      if (notify.error) return res.status(400).json({ error: notify.error });
      const allowed = resolveAllowedDomains(body);
      if (allowed.error) return res.status(400).json({ error: allowed.error });
      const preamble = resolvePreamble(body);
      if (preamble.error) return res.status(400).json({ error: preamble.error });
      const params = [project.id, body.name ?? null, slug.slug, notify.mode ?? null];
      // Order matters: each helper appends its own placeholders to `params`, so
      // the two array columns must be rendered in the order they are read.
      const notifyEmails = textArraySql('notify_emails', notify.emails, params);
      const allowedDomains = textArraySql('allowed_domains', allowed.domains, params);
      params.push(preamble.actions !== undefined ? JSON.stringify(preamble.actions) : null);
      const initialActions = `coalesce($${params.length}::jsonb, initial_actions)`;
      const { rows } = await db().query(
        `update projects set name = coalesce($2, name), slug = coalesce($3, slug),
                notify = coalesce($4, notify),
                notify_emails = ${notifyEmails},
                allowed_domains = ${allowedDomains},
                initial_actions = ${initialActions},
                updated_at = now()
          where id = $1 returning ${PROJECT_COLS}`,
        params
      );
      res.json(rows[0]);
    })
  );

  // Cascades to modules, suites and fixtures; member tests survive with
  // project_id nulled (decision 5).
  r.delete(
    '/:project',
    h(async (req, res) => {
      // @ts-expect-error — set by r.param
      const projectId = req.project.id;
      await db().query('delete from projects where id = $1', [projectId]);
      // The rows cascade; the bytes do not. Fixtures live outside runs/<id>/ so
      // retention never reaches them (US-048), which means this is the only
      // thing that ever will — skip it and a deleted project's files sit on the
      // disk forever, counting against nobody's quota and owned by no one.
      removeProjectFixtures(projectId);
      res.status(204).end();
    })
  );

  // Fixtures (US-048): files this project's tests may attach. Registered on
  // this router, not mounted as a sub-router, so the `r.param('project')`
  // resolver above — which is what scopes them to the calling tenant — runs
  // first and a stranger's project 404s before any of this touches the disk.
  r.get('/:project/fixtures', h(listFixtures));
  r.post('/:project/fixtures', fixtureBody, h(uploadFixture));
  r.delete('/:project/fixtures/:filename', h(deleteFixture));

  // Saved browser sessions (US-043), registered here for exactly the reason
  // above: the tenant scoping is `r.param('project')`, and a session blob is a
  // credential, so it must not be reachable by a mounting mistake.
  r.get('/:project/sessions', h(listSessions));
  r.post('/:project/sessions', h(createSession));
  r.put('/:project/sessions/:id', h(updateSession));
  r.delete('/:project/sessions/:id', h(deleteSession));
  // US-063: mints the token a browser extension trades at the *unauthenticated*
  // POST /api/capture (routes/capture.js) — that route is deliberately outside
  // this tenant-scoped router, since the extension holds no QAssist login of
  // its own and the capture token is its only credential.
  r.post('/:project/sessions/:id/capture-token', h(mintSessionCaptureToken));

  r.post(
    '/:project/run',
    requireEntitled,
    requireAgentKey,
    withUserCap,
    h(async (req, res) => {
      // @ts-expect-error — set by r.param
      const project = req.project;
      const { rows: tests } = await db().query(
        `select ${RUNNABLE_TEST_COLS} from ${RUNNABLE_TEST_FROM}
          where t.project_id = $1 order by t.created_at`,
        [project.id]
      );
      if (!tests.length) return res.status(400).json({ error: 'project has no tests' });
      res.json({
        projectId: project.id,
        runs: await runTestsFromRequest(tests, req.body || {}, /** @type {AppRequest} */ (req).runOpenaiKey),
      });
    })
  );

  r.get(
    '/:project/modules',
    h(async (req, res) => {
      // @ts-expect-error — set by r.param
      res.json({ modules: await listModules(req.project.id) });
    })
  );

  r.post(
    '/:project/modules',
    h(async (req, res) => {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      // @ts-expect-error — set by r.param
      const projectId = req.project.id;
      const slug = await uniqueSlug('modules', 'project_id', projectId, name);
      const { rows } = await db().query(
        `insert into modules (project_id, name, slug) values ($1, $2, $3)
         returning ${MODULE_COLS}`,
        [projectId, name, slug]
      );
      res.status(201).json({ ...rows[0], test_count: 0 });
    })
  );

  // Slug-addressable module trigger — the form US-008 documents for CI.
  r.post(
    '/:project/modules/:module/run',
    requireEntitled,
    requireAgentKey,
    withUserCap,
    h(async (req, res) => {
      // @ts-expect-error — set by r.param
      const mod = await findModule(req.project.id, req.params.module);
      if (!mod) return res.status(404).json({ error: 'not found' });
      const result = await runModule(mod, req.body || {}, /** @type {AppRequest} */ (req).runOpenaiKey);
      if (result.empty) return res.status(400).json({ error: 'module has no tests' });
      res.json(result);
    })
  );

  return r;
}
