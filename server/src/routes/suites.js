// @ts-check
// Suites (US-009): named groups of tests for one-shot triggering — the unit
// US-008 CI calls. Running a suite creates one run per member test and
// returns the run ids; callers poll each run (no suite_runs table).
import express from 'express';
import { db, getOperatorUserId, isUuid } from '../db.js';
import { createRun } from '../runs.js';
import { h, requireDb, requireAgentKey } from './helpers.js';

const TRIGGERS = new Set(['ui', 'api', 'ci']);

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

/** Validate a test_ids payload; returns an error string or null. */
async function checkTestIds(testIds) {
  if (!Array.isArray(testIds)) return 'test_ids must be an array of test ids';
  if (testIds.some((id) => typeof id !== 'string' || !isUuid(id))) {
    return 'test_ids contains an invalid id';
  }
  if (new Set(testIds).size !== testIds.length) return 'test_ids contains duplicates';
  for (const id of testIds) {
    const { rowCount } = await db().query('select 1 from tests where id = $1', [id]);
    if (!rowCount) return `unknown test id: ${id}`;
  }
  return null;
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
    h(async (_req, res) => {
      const { rows } = await db().query(
        'select id, name, created_at, updated_at from suites order by created_at desc'
      );
      const members = await memberIdsBySuite();
      res.json({ suites: rows.map((s) => ({ ...s, test_ids: members.get(s.id) || [] })) });
    })
  );

  r.post(
    '/',
    h(async (req, res) => {
      const { name, test_ids = [] } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      const bad = await checkTestIds(test_ids);
      if (bad) return res.status(400).json({ error: bad });
      const { rows } = await db().query(
        'insert into suites (user_id, name) values ($1, $2) returning id, name, created_at, updated_at',
        [getOperatorUserId(), name]
      );
      await setMembers(rows[0].id, test_ids);
      res.status(201).json({ ...rows[0], test_ids });
    })
  );

  r.get(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rows } = await db().query(
        'select id, name, created_at, updated_at from suites where id = $1',
        [req.params.id]
      );
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
      if (test_ids !== undefined) {
        const bad = await checkTestIds(test_ids);
        if (bad) return res.status(400).json({ error: bad });
      }
      const { rows } = await db().query(
        `update suites set name = coalesce($2, name), updated_at = now()
          where id = $1 returning id, name, created_at, updated_at`,
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
      const body = req.body || {};
      const trigger = TRIGGERS.has(body.trigger) ? body.trigger : 'api';
      const started = tests.map((t) => {
        const run = createRun({
          goal: t.goal,
          start_url: body.start_url || t.start_url,
          max_steps: t.max_steps,
          model: t.model,
          test_id: t.id,
          trigger,
        });
        return { runId: run.id, testId: t.id, status: run.status };
      });
      res.json({ suiteId: req.params.id, runs: started });
    })
  );

  return r;
}
