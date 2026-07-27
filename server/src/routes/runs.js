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
import { db, isUuid, currentUserId } from '../db.js';
import { createRun, getRun, stepsOf, stopRun, verdictOf } from '../runs.js';
import { ARTIFACTS_DIR, RECORDING_FILENAME, REPORT_DATA_FILENAME } from '../config.js';
import { h, requireDb, requireAgentKey, requireEntitled, withUserCap, respondOverCap, STORED_TRIGGERS } from './helpers.js';

/** Mirrors the runs.status check constraint (001_init.sql, widened by 011). */
const STATUSES = new Set([
  'queued', 'running', 'passed', 'failed', 'completed', 'error', 'cancelled',
]);

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
  r.variables, r.failure_reason, t.name as test_name, t.project_id, t.module_id`;

/**
 * Translate ?test_id/?status/?trigger/?project_id/?since/?until into a WHERE
 * clause.
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
  if (q.trigger !== undefined) {
    // Comma-separated like status, so "started by hand" is one request over
    // 'ui,api' rather than a filter per entry point.
    const wanted = String(q.trigger).split(',').map((s) => s.trim()).filter(Boolean);
    if (!wanted.length || wanted.some((t) => !STORED_TRIGGERS.has(t))) {
      return { error: 'invalid trigger', where: '', params: [] };
    }
    add('r.trigger = any($?)', wanted);
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

/**
 * The list-shape columns an in-memory run owns. Persistence is
 * fire-and-forget, so while a run is in the relay these are ahead of the row —
 * and for the two moments there is no row at all (no control plane, or the gap
 * before the insert lands) they are the whole answer. Mirrors what
 * persistUpdate() writes; the test's name and grouping and the artifact-pruning
 * stamp are the row's alone, since they only exist via the join.
 */
function liveRow(run) {
  const res = run.result || {};
  const failedOrError = run.status === 'error' || run.status === 'failed';
  return {
    id: run.id,
    test_id: run.test_id,
    trigger: run.trigger,
    goal: run.goal,
    start_url: run.start_url,
    status: run.status,
    success: verdictOf(run),
    final_result: res.final_result ?? res.message ?? null,
    error: failedOrError ? res.message ?? null : null,
    steps_count: res.steps ?? run.events.filter((e) => e.type === 'step').length,
    created_at: new Date(run.createdAt),
    started_at: run.startedAt ? new Date(run.startedAt) : null,
    finished_at: run.finishedAt ? new Date(run.finishedAt) : null,
    report_status: run.reportStatus || 'none',
    has_recording: !!run.recordingFile,
    variables: run.variables || {},
    // US-042: null unless the navigation fence fired, so a reader can tell a
    // confined run from a crashed one without parsing `error`.
    failure_reason: res.failure_reason ?? null,
  };
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
 * A live (in-memory) run only when it belongs to the caller — else null, so a
 * guessed runId can't reach another tenant's live run or its artifacts. In
 * auth-off mode every run is the operator's, so this never narrows.
 * @param {string} id
 */
function ownedLiveRun(id) {
  const run = getRun(id);
  return run && run.user_id === currentUserId() ? run : null;
}

/**
 * Whether a persisted run belongs to the caller. Guards the on-disk artifacts
 * (report, recording, steps) that are served by runId, which is otherwise
 * unguessable but not a permission. No control plane = legacy in-memory mode,
 * where there is nothing to scope.
 * @param {string} id
 */
async function runOwned(id) {
  if (!db()) return true;
  const { rowCount } = await db().query('select 1 from runs where id = $1 and user_id = $2', [
    id,
    currentUserId(),
  ]);
  return !!rowCount;
}

/**
 * @param {{
 *   checkToken: import('express').RequestHandler,
 *   checkTokenOrQuery: import('express').RequestHandler,
 * }} deps
 */
export function runsRouter({ checkToken, checkTokenOrQuery }) {
  const r = express.Router();

  r.post('/', checkToken, requireEntitled, requireAgentKey, withUserCap, (req, res) => {
    const { goal, start_url, max_steps } = req.body || {};
    if (!goal || !start_url) {
      return res.status(400).json({ error: 'goal and start_url are required' });
    }
    // user_id defaults to the gate-resolved caller (currentUserId) inside createRun.
    // openai_api_key is the key requireAgentKey resolved (request > stored > server).
    const run = createRun({
      goal,
      start_url,
      max_steps,
      openai_api_key: /** @type {any} */ (req).runOpenaiKey,
    });
    if ('blocked' in run) return res.status(400).json({ error: run.error, reason: run.reason });
    if ('rejected' in run) return respondOverCap(res, run);
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

      // Scope to the caller: history only ever lists a user's own runs.
      const params = [...filters.params, currentUserId()];
      const where = filters.where
        ? `${filters.where} and r.user_id = $${params.length}`
        : `where r.user_id = $${params.length}`;
      const from = 'from runs r left join tests t on t.id = r.test_id';
      const { rows: totals } = await db().query(
        `select count(*)::int as total ${from} ${where}`,
        params
      );
      const { rows } = await db().query(
        `select ${LIST_COLS} ${from} ${where}
          order by r.created_at desc
          limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, paging.limit, paging.offset]
      );
      res.json({
        runs: rows.map(shapeRun),
        total: totals[0].total,
        limit: paging.limit,
        offset: paging.offset,
      });
    })
  );

  // One run, in the list shape (US-030: /runs/<id> renders it through the same
  // RunDetail the history panel uses, so the two can't drift). The camelCase
  // keys are kept on top of those columns because CI polls this endpoint —
  // docs/ci.md reads `status`, `result.final_result` and `error`.
  r.get(
    '/:id',
    checkToken,
    h(async (req, res) => {
      const live = ownedLiveRun(req.params.id);
      let row = null;
      if (db() && isUuid(req.params.id)) {
        const { rows } = await db().query(
          `select ${LIST_COLS} from runs r left join tests t on t.id = r.test_id
            where r.id = $1 and r.user_id = $2`,
          [req.params.id, currentUserId()]
        );
        if (rows.length) row = shapeRun(rows[0]);
      }
      if (!live && !row) return res.status(404).json({ error: 'not found' });

      const base = {
        test_name: null,
        project_id: null,
        module_id: null,
        artifacts_deleted_at: null,
        ...row,
        ...(live ? liveRow(live) : {}),
      };
      const result =
        base.success === null && base.final_result === null
          ? null
          : { success: base.success, final_result: base.final_result };

      res.json({
        ...base,
        runId: base.id,
        testId: base.test_id,
        result,
        reportStatus: base.report_status,
        hasRecording: base.has_recording,
        ...(live ? { eventCount: live.events.length } : {}),
      });
    })
  );

  // Stop a run early (US-047). Deliberately behind neither requireEntitled nor
  // requireAgentKey: stopping is how a user stops spending, so it has to work
  // for an account whose subscription lapsed or whose key was removed while a
  // run was in flight — the two moments they most want the lever.
  r.post(
    '/:id/stop',
    checkToken,
    h(async (req, res) => {
      const run = ownedLiveRun(req.params.id);
      if (run) {
        if (!stopRun(run)) return res.status(409).json({ error: 'run has already finished' });
        // A queued run is cancelled by the time this returns; a running one is
        // still running until its process ends, which is what `stopping` says.
        return res.json({
          runId: run.id,
          status: run.status,
          stopping: run.status !== 'cancelled',
        });
      }
      // Not in the relay. Either it is the caller's own run, finished long
      // enough ago to have left — say so — or it is not theirs at all, which
      // answers 404 like every other run route, so a refusal never confirms
      // another tenant's run exists.
      if (db() && isUuid(req.params.id) && (await runOwned(req.params.id))) {
        return res.status(409).json({ error: 'run has already finished' });
      }
      res.status(404).json({ error: 'not found' });
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
      const run = ownedLiveRun(req.params.id);
      if (run) return res.json({ steps: stepsOf(run) });
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      if (!(await runOwned(req.params.id))) return res.status(404).json({ error: 'not found' });
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
      if (!(await runOwned(req.params.id))) return res.status(404).json({ error: 'not found' });
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
      const run = ownedLiveRun(req.params.id);
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
      const { rows } = await db().query(
        'select report_status from runs where id = $1 and user_id = $2',
        [req.params.id, currentUserId()]
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      answer(rows[0].report_status);
    })
  );

  return r;
}
