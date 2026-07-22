// @ts-check
// Artifact retention (US-011). A history row is a few hundred bytes and is
// kept forever; the runs/<id>/ directory beside it holds a PDF and an mp4 —
// tens of MB — and is what actually fills the disk. After
// ARTIFACT_RETENTION_DAYS the directory goes and the row is stamped
// `artifacts_deleted_at`, so the verdict, timings and steps survive while the
// download links stop being offered.
//
// The sweep is driven by the directory listing rather than by a DB query, so
// it also collects orphans: dirs from a run that was never persisted (no
// DATABASE_URL) or whose row was deleted. That makes it the one code path that
// bounds disk in both the control-plane and the legacy in-memory mode.
import fs from 'node:fs';
import path from 'node:path';
import { db, isUuid } from './db.js';
import { ARTIFACTS_DIR, ARTIFACT_RETENTION_DAYS } from './config.js';
import { getRun, TERMINAL } from './runs.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Often enough that a box near its disk limit recovers the same day, rarely
// enough to be invisible. Also runs once at boot, which is what makes it work
// on a machine that is only up for a few hours at a time.
const SWEEP_MS = 6 * 60 * 60 * 1000;

/**
 * Delete artifact directories last written before the cutoff.
 * @param {number} [now] injectable clock, for tests
 * @returns {Promise<{ pruned: number, skipped: number }>}
 */
export async function sweepArtifacts(now = Date.now()) {
  if (!ARTIFACT_RETENTION_DAYS || ARTIFACT_RETENTION_DAYS < 0) return { pruned: 0, skipped: 0 };
  const cutoff = now - ARTIFACT_RETENTION_DAYS * DAY_MS;

  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
  } catch {
    return { pruned: 0, skipped: 0 }; // nothing has run yet
  }

  let pruned = 0;
  let skipped = 0;
  for (const entry of entries) {
    // Only ever touch uuid-named directories: this deletes recursively, and
    // ARTIFACTS_DIR is operator-configurable, so anything that isn't clearly
    // ours is left alone.
    if (!entry.isDirectory() || !isUuid(entry.name)) continue;
    const dir = path.join(ARTIFACTS_DIR, entry.name);

    // mtime is the last write into the directory, i.e. roughly when the run
    // finished — the run's own timestamps live in the DB, which may not exist.
    let mtimeMs;
    try {
      ({ mtimeMs } = fs.statSync(dir));
    } catch {
      continue; // vanished under us
    }
    if (mtimeMs >= cutoff) continue;

    // Belt and braces against a clock jump: never delete under a live run.
    const live = getRun(entry.name);
    if (live && !TERMINAL.has(live.status)) {
      skipped++;
      continue;
    }

    // Stamp first, delete second. A crash in between leaves a row that says
    // "pruned" and a directory that still exists — the next sweep sees the
    // stale directory and finishes the job. The other order would leave a row
    // advertising a report that 404s, with no directory left to trigger a retry.
    if (db()) {
      await db().query(
        'update runs set artifacts_deleted_at = now() where id = $1 and artifacts_deleted_at is null',
        [entry.name]
      );
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      pruned++;
    } catch (err) {
      console.error(`retention: could not remove ${dir}:`, err);
    }
  }

  if (pruned) {
    console.log(
      `retention: pruned ${pruned} run artifact dir(s) older than ${ARTIFACT_RETENTION_DAYS} day(s)`
    );
  }
  return { pruned, skipped };
}

/** Sweep at boot, then every SWEEP_MS. Unref'd so it never holds the process open. */
export function startRetention() {
  if (!ARTIFACT_RETENTION_DAYS) {
    console.warn('retention: ARTIFACT_RETENTION_DAYS=0 — run artifacts are kept forever');
    return null;
  }
  const run = () => sweepArtifacts().catch((err) => console.error('retention sweep failed:', err));
  run();
  const timer = setInterval(run, SWEEP_MS);
  timer.unref();
  return timer;
}
