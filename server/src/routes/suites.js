// @ts-check
// Suites (US-009): named groups of tests for one-shot triggering — the unit
// US-008 CI calls. Running a suite creates one run per member test and
// returns the run ids; callers poll each run (no suite_runs table).
import express from 'express';
import { db, getOperatorUserId, isUuid } from '../db.js';
import { h, requireDb, requireAgentKey, runTests } from './helpers.js';

const COLS = 'id, name, project_id, created_at, updated_at';

/**
 * Replace a suite's member list. testIds order defines run order.
 * @param {string} suiteId
 * @param {string[]} testIds
 */
async function setMembers(suiteId, testIds) {
  await db().query('delete from suite_tests where suite_id = $1', [suiteId]);
  for (let i = 0; i < testIds.length; i++) {
    await db().query(
      'insert into suite_tests (suite_id, test_id, position) values ($1, $2, $3)',
      [suiteId, testIds[i], i]
    );
  }
}

/**
 * Validate a test_ids payload against the suite's project; returns an error
 * string or null. Membership is confined to the suite's project (US-023
 * decision 6) — an ungrouped test therefore can't be in any suite.
 * @param {any} testIds
 * @param {string} projectId
 */
async function checkTestIds(testIds, projectId) {
  if (!Array.isArray(testIds)) return 'test_ids must be an array of test ids';
  if (testIds.some((id) => typeof id !== 'string' || !isUuid(id))) {
    return 'test_ids contains an invalid id';
  }
  if (new Set(testIds).size !== testIds.length) return 'test_ids contains duplicates';
  for (const id of testIds) {
    const { rows } = await db().query('select project_id from tests where id = $1', [id]);
    if (!rows.length) return `unknown test id: ${id}`;
    if (rows[0].project_id !== projectId) {
      return `test ${id} is not in this suite's project`;
    }
  }
  return null;
}

/** Confirm a project exists and belongs to the operator. */
async function projectExists(projectId) {
  if (typeof projectId !== 'string' || !isUuid(projectId)) return false;
  const { rowCount } = await db().query(
    'select 1 from projects where id = $1 and user_id = $2',
    [projectId, getOperatorUserId()]
  );
  return !!rowCount;
}

async function memberIdsBySuite() {
  const { rows } = await db().query(
    'select suite_id, test_id from suite_tests order by position'
  );
  /** @type {Map<string, string[]>} */
  const bySuite = new Map();
  for (const row of rows) {
    if (!bySuite.has(row.suite_id)) bySuite.set(row.suite_id, []);
    bySuite.get(row.suite_id).push(row.test_id);
  }
  return bySuite;
}

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function suitesRouter({ checkToken }) {
  const r = express.Router();
  r.use(checkToken, requireDb);

  r.get(
    '/',
    h(async (req, res) => {
      const { project_id } = req.query;
      const filtered = typeof project_id === 'string' && project_id;
      if (filtered && !isUuid(project_id)) {
        return res.status(400).json({ error: 'invalid project_id' });
      }
      const { rows } = await db().query(
        `select ${COLS} from suites ${filtered ? 'where project_id = $1' : ''}
         order by created_at desc`,
        filtered ? [project_id] : []
      );
      const members = await memberIdsBySuite();
      res.json({ suites: rows.map((s) => ({ ...s, test_ids: members.get(s.id) || [] })) });
    })
  );

  r.post(
    '/',
    h(async (req, res) => {
      const { name, project_id, test_ids = [] } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (!(await projectExists(project_id))) {
        return res.status(400).json({ error: 'project_id is required and must exist' });
      }
      const bad = await checkTestIds(test_ids, project_id);
      if (bad) return res.status(400).json({ error: bad });
      const { rows } = await db().query(
        `insert into suites (user_id, name, project_id) values ($1, $2, $3)
         returning ${COLS}`,
        [getOperatorUserId(), name, project_id]
      );
      await setMembers(rows[0].id, test_ids);
      res.status(201).json({ ...rows[0], test_ids });
    })
  );

  r.get(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rows } = await db().query(`select ${COLS} from suites where id = $1`, [
        req.params.id,
      ]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      const { rows: tests } = await db().query(
        `select t.id, t.name, t.goal, t.start_url, t.max_steps, t.model
           from suite_tests st join tests t on t.id = st.test_id
          where st.suite_id = $1 order by st.position`,
        [req.params.id]
      );
      res.json({ ...rows[0], tests });
    })
  );

  r.put(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { name, test_ids } = req.body || {};
      // A suite never changes project — membership is scoped to it, so moving
      // one would invalidate every member at once. Delete and recreate instead.
      const { rows: existing } = await db().query(
        'select project_id from suites where id = $1',
        [req.params.id]
      );
      if (!existing.length) return res.status(404).json({ error: 'not found' });
      if (test_ids !== undefined) {
        const bad = await checkTestIds(test_ids, existing[0].project_id);
        if (bad) return res.status(400).json({ error: bad });
      }
      const { rows } = await db().query(
        `update suites set name = coalesce($2, name), updated_at = now()
          where id = $1 returning ${COLS}`,
        [req.params.id, name ?? null]
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      if (test_ids !== undefined) await setMembers(req.params.id, test_ids);
      const members = await memberIdsBySuite();
      res.json({ ...rows[0], test_ids: members.get(req.params.id) || [] });
    })
  );

  r.delete(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rowCount } = await db().query('delete from suites where id = $1', [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      res.status(204).end();
    })
  );

  // Run every member test. Optional start_url override applies to all runs
  // (US-008: point the whole suite at a fresh preview URL).
  r.post(
    '/:id/run',
    requireAgentKey,
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rowCount } = await db().query('select 1 from suites where id = $1', [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      const { rows: tests } = await db().query(
        `select t.id, t.goal, t.start_url, t.max_steps, t.model
           from suite_tests st join tests t on t.id = st.test_id
          where st.suite_id = $1 order by st.position`,
        [req.params.id]
      );
      if (!tests.length) return res.status(400).json({ error: 'suite has no tests' });
      res.json({ suiteId: req.params.id, runs: runTests(tests, req.body || {}) });
    })
  );

  return r;
}
