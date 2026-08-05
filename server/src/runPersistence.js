// @ts-check
// Everything a run writes outside itself once it has state worth keeping: the
// runs row, a login run's refreshed session, and the one mail per finished run.
//
// Fire-and-forget throughout — the live relay never waits on the DB — but
// ordered: writes for one run are chained on `run.persisted` so they reach the
// DB in program order. Without that chain, `persistInsert` and the `running`
// `persistUpdate` fired back-to-back in `createRun`/`startRun` are two
// independent pool queries: the UPDATE can reach a connection before the INSERT
// commits, match zero rows, and leave the row stuck at `queued`.
import { db } from './db.js';
import { refreshCapturedSession } from './browserSession.js';
import { notifyRunFinished } from './notify.js';
import { stepCount, verdictOf } from './runState.js';

export function persistInsert(run) {
  if (!db()) return;
  run.persisted = db()
    .query(
      `insert into runs (id, test_id, user_id, trigger, goal, start_url, max_steps, model, status, variables,
                        schedule_id, scheduled_for)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        run.id,
        run.test_id,
        run.user_id,
        run.trigger,
        run.goal,
        run.start_url,
        run.max_steps,
        run.model,
        run.status,
        JSON.stringify(run.variables || {}),
        run.schedule_id,
        run.scheduled_for,
      ]
    )
    .catch((err) => console.error(`db: insert run ${run.id.slice(0, 8)} failed:`, err.message));
}

export function persistUpdate(run) {
  if (!db()) return;
  const res = run.result || {};
  const failedOrError = run.status === 'error' || run.status === 'failed';
  const update = () =>
    db()
      .query(
        `update runs
            set status        = $2,
                success       = $3,
                final_result  = $4,
                error         = $5,
                steps_count   = $6,
                started_at    = $7,
                finished_at   = $8,
                report_status = $9,
                has_recording = $10,
                failure_reason = $11
          where id = $1`,
        [
          run.id,
          run.status,
          verdictOf(run),
          res.final_result ?? res.message ?? null,
          failedOrError ? res.message ?? null : null,
          stepCount(run),
          run.startedAt ? new Date(run.startedAt) : null,
          run.finishedAt ? new Date(run.finishedAt) : null,
          run.reportStatus || 'none',
          !!run.recordingFile,
          // Null on every ordinary run, which is what keeps a value here
          // meaning "the fence fired" rather than "something went wrong".
          res.failure_reason ?? null,
        ]
      )
      .catch((err) => console.error(`db: update run ${run.id.slice(0, 8)} failed:`, err.message));
  run.persisted = (run.persisted || Promise.resolve()).then(update);
}

// Store what a passing login run captured (US-043). Chained on `run.persisted`
// for persistInsert's reason — it must not race the run's own row — and
// fire-and-forget from the agent's point of view, which is why a failure here
// is logged rather than thrown: the run itself passed, and the session simply
// did not refresh.
export function captureSession(run, exported) {
  if (!db()) return;
  run.persisted = (run.persisted || Promise.resolve()).then(() =>
    refreshCapturedSession(run.capture_session_id, exported).catch((err) =>
      console.error(`db: refresh session for run ${run.id.slice(0, 8)} failed:`, err.message)
    )
  );
}

// A run is mailable (US-012) once it has finished *and* the report it would
// attach has stopped changing. Those two arrive in either order — the renderer
// usually outlives the agent process, but a watchdog kill doesn't wait for it —
// so both paths call this and whichever completes the pair wins. The flag is
// belt and braces over the notifications table's own (run_id, recipient) key.
export function maybeNotify(run) {
  if (run.notified || !run.finishedAt || run.reportStatus === 'generating') return;
  run.notified = true;
  notifyRunFinished(run).catch((err) =>
    console.error(`notify ${run.id.slice(0, 8)} failed:`, err.message)
  );
}
