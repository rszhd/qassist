// @ts-check
// Demo replay (US-036): the no-cost stand-in for startRun.
//
// Drive a run from a checked-in fixture instead of a Python agent: no spawn, no
// `active++`, no queue. Events replay over the same relay a real run uses, so
// the Run stage and history need no second code path. The fixture is chosen to
// match the test; its recording/PDF are symlinked (not copied) into the run dir
// so the normal media routes serve them and the reaper's rm -rf reclaims them.
//
// Which fixture and how it is read is `demo.js`; this module only replays one.
import fs from 'node:fs';
import path from 'node:path';
import { ARTIFACTS_DIR, DEMO_SPEED, RECORDING_FILENAME } from './config.js';
import { fixtureForRun, loadDemo, recordingPath, reportPath } from './demo.js';
import { broadcast } from './runRelay.js';
import { maybeNotify, persistUpdate } from './runPersistence.js';
import { evictLater, TERMINAL } from './runState.js';

export function startReplay(run) {
  const slug = fixtureForRun(run);
  const demo = loadDemo(slug);
  run.startedAt = Date.now();
  run.status = 'running';
  broadcast(run, { type: 'status', status: 'running' });
  persistUpdate(run);

  if (!demo) {
    // No usable fixture at all — finish clean so the row still reaches terminal
    // rather than hanging at 'running'.
    finishReplay(run);
    return;
  }
  run.demoSlug = slug;
  linkFixtureArtifacts(run, slug);

  // A demo run has no live screencast — the fixture's recording *is* the stage
  // feed. Announce it up front (durable, so a viewer connecting mid-replay still
  // gets it) so the frontend plays the video from the start instead of waiting
  // on frames that never arrive. `demo: true` tells it to show the video live
  // rather than only offering it as a post-run button.
  if (run.recordingFile) broadcast(run, { type: 'recording', demo: true });

  let last = 0;
  for (const { offset_ms, ...evt } of demo.events) {
    const at = Math.max(0, Number(offset_ms) || 0) / DEMO_SPEED;
    last = Math.max(last, at);
    setTimeout(() => applyReplayEvent(run, evt), at).unref();
  }
  setTimeout(() => finishReplay(run), last).unref();
}

// Same event handling as startRun's stdout loop: a fixture's `done`/`error`
// carries the verdict that sets the terminal status; everything else is relayed.
function applyReplayEvent(run, evt) {
  if (TERMINAL.has(run.status)) return; // a later timer after finishReplay: ignore
  if (evt.type === 'done') {
    run.result = evt;
    run.status = evt.success === true ? 'passed' : evt.success === false ? 'failed' : 'completed';
  } else if (evt.type === 'error') {
    run.result = evt;
    run.status = 'error';
  }
  broadcast(run, evt);
}

function finishReplay(run) {
  if (run.finishedAt) return; // already ended — a stop (US-047) beat this timer
  if (!TERMINAL.has(run.status)) run.status = 'completed';
  run.finishedAt = Date.now();
  run.reportStatus = run.reportReady ? 'ready' : 'none';
  persistUpdate(run);
  broadcast(run, { type: 'end', status: run.status, demo: true });
  maybeNotify(run);
  evictLater(run.id);
}

// Symlink the fixture's shared recording/PDF into runs/<id>/ so /api/runs/:id/
// {recording,report.pdf} serve them unchanged. Symlink, not copy: the fixture
// stays the single shared source, and the reaper's rm -rf runs/<id> removes only
// the links. Best-effort — a run row is honest about what actually linked.
function linkFixtureArtifacts(run, slug) {
  const runDir = path.join(ARTIFACTS_DIR, run.id);
  try {
    fs.mkdirSync(runDir, { recursive: true });
  } catch {
    /* dir may already exist */
  }
  const rec = recordingPath(slug);
  if (rec) {
    try {
      fs.symlinkSync(rec, path.join(runDir, RECORDING_FILENAME));
      run.recordingFile = path.join(runDir, RECORDING_FILENAME);
    } catch {
      /* leaves has_recording false */
    }
  }
  const rep = reportPath(slug);
  if (rep) {
    try {
      fs.symlinkSync(rep, path.join(runDir, 'report.pdf'));
      run.reportReady = true;
    } catch {
      /* leaves report_status none */
    }
  }
}
