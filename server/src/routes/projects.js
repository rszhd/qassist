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
import { db, getOperatorUserId, isUuid } from '../db.js';
import { h, requireDb, requireAgentKey, runTestsFromRequest, slugify } from './helpers.js';

export const PROJECT_COLS = 'id, name, slug, created_at, updated_at';
export const MODULE_COLS = 'id, project_id, name, slug, created_at, updated_at';
const TEST_RUN_COLS = 'id, goal, start_url, max_steps, model';

/**
 * Resolve a :project param (uuid or slug) to its row, or null.
 * @param {string} ref
 */
async function findProject(ref) {
  const where = isUuid(ref) ? 'id = $2' : 'slug = $2';
  const { rows } = await db().query(
    `select ${PROJECT_COLS} from projects where user_id = $1 and ${where}`,
    [getOperatorUserId(), ref]
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
    [id, getOperatorUserId()]
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
    projectId ? [getOperatorUserId(), projectId] : [getOperatorUserId()]
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

/** Start a run per member test of a module; `{ empty: true }` when it has none. */
export async function runModule(mod, body) {
  const { rows: tests } = await db().query(
    `select ${TEST_RUN_COLS} from tests where module_id = $1 order by created_at`,
    [mod.id]
  );
  if (!tests.length) return { empty: true };
  return { moduleId: mod.id, runs: runTestsFromRequest(tests, body) };
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
            // @ts-expect-error — request-scoped stash, no augmentation needed
            req.project = project;
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
        [getOperatorUserId()]
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
      const userId = getOperatorUserId();
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
      const { rows: counts } = await db().query(
        'select count(*)::int as test_count from tests where project_id = $1',
        [project.id]
      );
      res.json({ ...project, modules, test_count: counts[0].test_count });
    })
  );

  r.put(
    '/:project',
    h(async (req, res) => {
      // @ts-expect-error — set by r.param
      const project = req.project;
      const body = req.body || {};
      const slug = await resolveSlug(body, project, 'projects', 'user_id', getOperatorUserId());
      if (slug.error) return res.status(400).json({ error: slug.error });
      const { rows } = await db().query(
        `update projects set name = coalesce($2, name), slug = coalesce($3, slug),
                updated_at = now()
          where id = $1 returning ${PROJECT_COLS}`,
        [project.id, body.name ?? null, slug.slug]
      );
      res.json(rows[0]);
    })
  );

  // Cascades to modules and suites; member tests survive with project_id
  // nulled (decision 5).
  r.delete(
    '/:project',
    h(async (req, res) => {
      // @ts-expect-error — set by r.param
      await db().query('delete from projects where id = $1', [req.project.id]);
      res.status(204).end();
    })
  );

  r.post(
    '/:project/run',
    requireAgentKey,
    h(async (req, res) => {
      // @ts-expect-error — set by r.param
      const project = req.project;
      const { rows: tests } = await db().query(
        `select ${TEST_RUN_COLS} from tests where project_id = $1 order by created_at`,
        [project.id]
      );
      if (!tests.length) return res.status(400).json({ error: 'project has no tests' });
      res.json({ projectId: project.id, runs: runTestsFromRequest(tests, req.body || {}) });
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
    requireAgentKey,
    h(async (req, res) => {
      // @ts-expect-error — set by r.param
      const mod = await findModule(req.project.id, req.params.module);
      if (!mod) return res.status(404).json({ error: 'not found' });
      const result = await runModule(mod, req.body || {});
      if (result.empty) return res.status(400).json({ error: 'module has no tests' });
      res.json(result);
    })
  );

  return r;
}
