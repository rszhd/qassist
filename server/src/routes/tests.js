// @ts-check
// Saved tests (US-009): CRUD + one-click run. A saved test is the reusable
// unit (goal + start_url + settings); running one denormalizes those fields
// into the runs row so history survives edits/deletes.
import express from 'express';
import { db, getOperatorUserId, isUuid } from '../db.js';
import { createRun } from '../runs.js';
import { DEFAULT_MAX_STEPS } from '../config.js';
import { h, requireDb, requireAgentKey } from './helpers.js';

const COLS = 'id, name, goal, start_url, max_steps, model, created_at, updated_at';
const TRIGGERS = new Set(['ui', 'api', 'ci']); // 'schedule' is US-010's, not callers'

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function testsRouter({ checkToken }) {
  const r = express.Router();
  r.use(checkToken, requireDb);

  r.get(
    '/',
    h(async (_req, res) => {
      const { rows } = await db().query(`select ${COLS} from tests order by created_at desc`);
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
      const { rows } = await db().query(
        `insert into tests (user_id, name, goal, start_url, max_steps, model)
         values ($1, $2, $3, $4, $5, $6) returning ${COLS}`,
        [
          getOperatorUserId(),
          name,
          goal,
          start_url,
          Number(max_steps) || DEFAULT_MAX_STEPS,
          model || null,
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
      const { rows } = await db().query(
        `update tests
            set name       = coalesce($2, name),
                goal       = coalesce($3, goal),
                start_url  = coalesce($4, start_url),
                max_steps  = coalesce($5, max_steps),
                model      = nullif(coalesce($6, model), ''),
                updated_at = now()
          where id = $1 returning ${COLS}`,
        [
          req.params.id,
          name ?? null,
          goal ?? null,
          start_url ?? null,
          max_steps != null ? Number(max_steps) : null,
          model ?? null,
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
      const body = req.body || {};
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
