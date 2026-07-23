// @ts-check
// Run routes (US-011). Not to be confused with `src/runs.js` — that is the run
// engine (spawn, relay, watchdog); this is only its HTTP surface.
//
// Enqueueing and the live relay work without a control plane, so those routes
// apply checkToken per-route rather than requiring the DB. History is the
// exception: `GET /api/runs` reads the runs table, which is the source of
// truth for finished runs, so it 503s without DATABASE_URL.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, isUuid } from '../db.js';
import { createRun, getRun, stepsOf } from '../runs.js';
import { ARTIFACTS_DIR, RECORDING_FILENAME, REPORT_DATA_FILENAME } from '../config.js';
import { h, requireDb, requireAgentKey } from './helpers.js';

/** Mirrors the runs.status check constraint in 001_init.sql. */
const STATUSES = new Set(['queued', 'running', 'passed', 'failed', 'completed', 'error']);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// The list shape is the row plus the test's name and grouping. `runs` has no
// project_id of its own — a run's project is its test's, reached by join, so a
// run whose test was deleted (`on delete set null`) appears in no project
// filter. That is deliberate: history survives the delete, group membership
// doesn't, because the group it belonged to is no longer knowable.
const LIST_COLS = `r.id, r.test_id, r.trigger, r.goal, r.start_url, r.status,
  r.success, r.final_result, r.error, r.steps_count, r.created_at, r.started_at,
  r.finished_at, r.report_status, r.has_recording, r.artifacts_deleted_at,
  t.name as test_name, t.project_id, t.module_id`;

/**
 * Translate ?test_id/?status/?project_id/?since/?until into a WHERE clause.
 * Returns an error string instead of throwing so the caller can 400.
 * @param {Record<string, any>} q
 * @returns {{ error?: string, where: string, params: any[] }}
 */
function buildFilters(q) {
  /** @type {string[]} */
  const clauses = [];
  /** @type {any[]} */
  const params = [];
  /** @param {string} sql @param {any} value */
  const add = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace('$?', `$${params.length}`));
  };

  if (q.test_id !== undefined) {
    if (!isUuid(q.test_id)) return { error: 'invalid test_id', where: '', params: [] };
    add('r.test_id = $?', q.test_id);
  }
  if (q.status !== undefined) {
    // Comma-separated so the UI's "unfinished" and "failed or errored" filters
    // are one request each.
    const wanted = String(q.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (!wanted.length || wanted.some((s) => !STATUSES.has(s))) {
      return { error: 'invalid status', where: '', params: [] };
    }
    add('r.status = any($?)', wanted);
  }
  if (q.project_id !== undefined) {
    if (!isUuid(q.project_id)) return { error: 'invalid project_id', where: '', params: [] };
    add('t.project_id = $?', q.project_id);
  }
  if (q.module_id !== undefined) {
    if (!isUuid(q.module_id)) return { error: 'invalid module_id', where: '', params: [] };
    add('t.module_id = $?', q.module_id);
  }
  for (const [key, op] of [
    ['since', '>='],
    ['until', '<'],
  ]) {
    if (q[key] === undefined) continue;
    const at = new Date(q[key]);
    if (Number.isNaN(at.getTime())) return { error: `invalid ${key}`, where: '', params: [] };
    add(`r.created_at ${op} $?`, at.toISOString());
  }

  return { where: clauses.length ? `where ${clauses.join(' and ')}` : '', params };
}

/**
 * @param {Record<string, any>} q
 * @returns {{ error?: string, limit: number, offset: number }}
 */
function buildPaging(q) {
  const limit = q.limit === undefined ? DEFAULT_LIMIT : Number(q.limit);
  const offset = q.offset === undefined ? 0 : Number(q.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { error: `limit must be an integer between 1 and ${MAX_LIMIT}`, limit: 0, offset: 0 };
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return { error: 'offset must be a non-negative integer', limit: 0, offset: 0 };
  }
  return { limit, offset };
}

/** Artifact links are gone once retention prunes the directory (US-011). */
function shapeRun(row) {
  const pruned = !!row.artifacts_deleted_at;
  return {
    ...row,
    has_recording: row.has_recording && !pruned,
    report_status: pruned && row.report_status === 'ready' ? 'none' : row.report_status,
  };
}

/**
 * @param {{
 *   checkToken: import('express').RequestHandler,
 *   checkTokenOrQuery: import('express').RequestHandler,
 * }} deps
 */
export function runsRouter({ checkToken, checkTokenOrQuery }) {
  const r = express.Router();

  r.post('/', checkToken, requireAgentKey, (req, res) => {
    const { goal, start_url, max_steps } = req.body || {};
    if (!goal || !start_url) {
      return res.status(400).json({ error: 'goal and start_url are required' });
    }
    const run = createRun({ goal, start_url, max_steps });
    res.json({ runId: run.id, status: run.status });
  });

  // History (US-011). Newest first, `total` for pagination. Rows are returned
  // in DB shape (snake_case) like the other list endpoints — GET /:id below
  // keeps its camelCase live-relay shape, which the run view already consumes.
  r.get(
    '/',
    checkToken,
    requireDb,
    h(async (req, res) => {
      const filters = buildFilters(req.query);
      if (filters.error) return res.status(400).json({ error: filters.error });
      const paging = buildPaging(req.query);
      if (paging.error) return res.status(400).json({ error: paging.error });

      const from = 'from runs r left join tests t on t.id = r.test_id';
      const { rows: totals } = await db().query(
        `select count(*)::int as total ${from} ${filters.where}`,
        filters.params
      );
      const { rows } = await db().query(
        `select ${LIST_COLS} ${from} ${filters.where}
          order by r.created_at desc
          limit $${filters.params.length + 1} offset $${filters.params.length + 2}`,
        [...filters.params, paging.limit, paging.offset]
      );
      res.json({
        runs: rows.map(shapeRun),
        total: totals[0].total,
        limit: paging.limit,
        offset: paging.offset,
      });
    })
  );

  r.get(
    '/:id',
    checkToken,
    h(async (req, res) => {
      const run = getRun(req.params.id);
      if (run) {
        return res.json({
          runId: run.id,
          status: run.status,
          goal: run.goal,
          start_url: run.start_url,
          testId: run.test_id,
          result: run.result,
          eventCount: run.events.length,
          hasRecording: !!run.recordingFile,
        });
      }
      // Fallback: finished runs outlive the in-memory relay in the DB.
      if (!db() || !isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rows } = await db().query('select * from runs where id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      const row = rows[0];
      res.json({
        runId: row.id,
        status: row.status,
        goal: row.goal,
        start_url: row.start_url,
        testId: row.test_id,
        result:
          row.success === null && row.final_result === null
            ? null
            : { success: row.success, final_result: row.final_result },
        error: row.error,
        reportStatus: row.report_status,
        hasRecording: row.has_recording && !row.artifacts_deleted_at,
      });
    })
  );

  // Step-by-step activity (US-026), so a past run can explain itself in History
  // rather than only in the PDF. A read path over what generateReport() already
  // wrote: the live buffer while the run is still in the relay, report_data.json
  // afterwards. Pruned (or never written, if the process died before finishing)
  // => 404, same as a missing recording.
  r.get(
    '/:id/steps',
    checkToken,
    h(async (req, res) => {
      const run = getRun(req.params.id);
      if (run) return res.json({ steps: stepsOf(run) });
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const file = path.join(ARTIFACTS_DIR, req.params.id, REPORT_DATA_FILENAME);
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'no steps' });
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      res.json({ steps: data.steps || [] });
    })
  );

  // Session recording (US-006). The file on disk is the source of truth — a run
  // whose artifacts were pruned simply 404s. sendFile handles Range requests,
  // so browsers can seek without downloading the whole video (which is why this
  // is a plain <video src> with a query token, not a fetched blob).
  r.get(
    '/:id/recording',
    checkTokenOrQuery,
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const file = path.join(ARTIFACTS_DIR, req.params.id, RECORDING_FILENAME);
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'no recording' });
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="qassist-${req.params.id.slice(0, 8)}.mp4"`
      );
      res.sendFile(file);
    })
  );

  r.get(
    '/:id/report.pdf',
    checkToken,
    h(async (req, res) => {
      const run = getRun(req.params.id);
      const pdfPath = run?.reportPath || path.join(ARTIFACTS_DIR, req.params.id, 'report.pdf');
      /** @param {string} status */
      const answer = (status) => {
        if (status === 'ready' && fs.existsSync(pdfPath)) {
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader(
            'Content-Disposition',
            `inline; filename="qassist-report-${req.params.id.slice(0, 8)}.pdf"`
          );
          return res.sendFile(pdfPath);
        }
        if (status === 'generating') return res.status(202).json({ status: 'generating' });
        if (status === 'error') return res.status(500).json({ error: 'report generation failed' });
        return res.status(404).json({ error: 'no report (run not finished?)' });
      };
      if (run) return answer(run.reportStatus);
      if (!db() || !isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rows } = await db().query('select report_status from runs where id = $1', [
        req.params.id,
      ]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      answer(rows[0].report_status);
    })
  );

  return r;
}
