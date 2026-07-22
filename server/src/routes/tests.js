// @ts-check
// Saved tests (US-009): CRUD + one-click run. A saved test is the reusable
// unit (goal + start_url + settings); running one denormalizes those fields
// into the runs row so history survives edits/deletes.
import express from 'express';
import { db, getOperatorUserId, isUuid } from '../db.js';
import { createRun } from '../runs.js';
import { DEFAULT_MAX_STEPS } from '../config.js';
import { h, requireDb, requireAgentKey, TRIGGERS } from './helpers.js';

const COLS =
  'id, name, goal, start_url, max_steps, model, project_id, module_id, created_at, updated_at';

/**
 * Resolve the grouping a write asks for (US-023 decision 4): when module_id is
 * set, project_id is derived from that module so a test can never sit in
 * module `auth` of project A while claiming project B. Returns
 * `{ error }`, or `{ projectId, moduleId }` where `undefined` means "leave
 * unchanged" and `null` means "clear".
 * @param {{ project_id?: string|null, module_id?: string|null }} body
 */
async function resolveGrouping(body) {
  const { project_id, module_id } = body;
  if (module_id) {
    if (!isUuid(module_id)) return { error: 'unknown module_id' };
    const { rows } = await db().query('select id, project_id from modules where id = $1', [
      module_id,
    ]);
    if (!rows.length) return { error: 'unknown module_id' };
    return { projectId: rows[0].project_id, moduleId: rows[0].id };
  }
  // module_id explicitly cleared (null/'') → keep project_id, drop the module.
  const moduleId = module_id === undefined ? undefined : null;
  if (project_id === undefined) return { projectId: undefined, moduleId };
  if (project_id === null || project_id === '') return { projectId: null, moduleId: null };
  if (!isUuid(project_id)) return { error: 'unknown project_id' };
  const { rowCount } = await db().query('select 1 from projects where id = $1', [project_id]);
  if (!rowCount) return { error: 'unknown project_id' };
  // Setting a project without naming a module always clears the module: the
  // old one may belong to a different project, and one predictable rule beats
  // a conditional that depends on the row's previous state.
  return { projectId: project_id, moduleId: null };
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
      const where = [];
      const params = [];
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
        `select ${COLS} from tests
         ${where.length ? `where ${where.join(' and ')}` : ''}
         order by created_at desc`,
        params
      );
      res.json({ tests: rows });
    })
  );

  r.post(
    '/',
    h(async (req, res) => {
      const { name, goal, start_url, max_steps, model } = req.body || {};
      if (!name || !goal || !start_url) {
        return res.status(400).json({ error: 'name, goal and start_url are required' });
      }
      const group = await resolveGrouping(req.body || {});
      if (group.error) return res.status(400).json({ error: group.error });
      const { rows } = await db().query(
        `insert into tests (user_id, name, goal, start_url, max_steps, model,
                            project_id, module_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLS}`,
        [
          getOperatorUserId(),
          name,
          goal,
          start_url,
          Number(max_steps) || DEFAULT_MAX_STEPS,
          model || null,
          group.projectId ?? null,
          group.moduleId ?? null,
        ]
      );
      res.status(201).json(rows[0]);
    })
  );

  r.get(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rows } = await db().query(`select ${COLS} from tests where id = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json(rows[0]);
    })
  );

  // Partial update: omitted fields keep their value; model '' clears to the
  // server default.
  r.put(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { name, goal, start_url, max_steps, model } = req.body || {};
      const group = await resolveGrouping(req.body || {});
      if (group.error) return res.status(400).json({ error: group.error });
      // $7/$9 carry "was this field present at all?" so a null can mean
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
                updated_at = now()
          where id = $1 returning ${COLS}`,
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
        ]
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json(rows[0]);
    })
  );

  r.delete(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rowCount } = await db().query('delete from tests where id = $1', [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      res.status(204).end();
    })
  );

  // One-click re-run. Optional start_url override lets CI point the saved
  // test at a fresh preview URL (US-008).
  r.post(
    '/:id/run',
    requireAgentKey,
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rows } = await db().query(`select ${COLS} from tests where id = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      const test = rows[0];
      const body = /** @type {any} */ (req.body || {});
      const run = createRun({
        goal: test.goal,
        start_url: body.start_url || test.start_url,
        max_steps: body.max_steps != null ? Number(body.max_steps) : test.max_steps,
        model: test.model,
        test_id: test.id,
        trigger: TRIGGERS.has(body.trigger) ? body.trigger : 'api',
      });
      res.json({ runId: run.id, testId: test.id, status: run.status });
    })
  );

  return r;
}
