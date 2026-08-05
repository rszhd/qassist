// @ts-check
// Build the run's data JSON and render it to a PDF via the Python renderer
// (which reuses the installed Chromium). Runs once per finished run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARTIFACTS_DIR,
  MODEL,
  PUBLIC_BASE_URL,
  PYTHON_BIN,
  REPORT_DATA_FILENAME,
  REPORT_SCRIPT,
  REPORTS_ENABLED,
} from './config.js';
import { maybeNotify, persistUpdate } from './runPersistence.js';
import { diagnosticsOf, stepCount, stepsOf, verdictOf } from './runState.js';

/**
 * With REPORTS_ENABLED off the JSON is still written and only the render is
 * skipped: `report_data.json` is where the steps endpoint and US-044's
 * diagnostics come from, so dropping it would empty the run page as well.
 */
export function generateReport(run) {
  if (run.reportStatus === 'generating' || run.reportStatus === 'ready') return;
  run.reportStatus = 'generating';
  const runDir = path.join(ARTIFACTS_DIR, run.id);
  try {
    fs.mkdirSync(runDir, { recursive: true });
  } catch {
    /* dir may already exist from screenshots */
  }
  const res = run.result || {};
  const data = {
    runId: run.id,
    goal: run.goal,
    start_url: run.start_url,
    model: run.model || MODEL,
    status: run.status,
    success: verdictOf(run),
    duration_seconds: res.duration_seconds ?? null,
    steps_count: stepCount(run),
    final_result: res.final_result ?? res.message ?? null,
    errors: res.errors ?? (res.message ? [res.message] : []),
    // US-042: a run the navigation fence stopped says so on the report, so the
    // reader is not left reading a timeout and guessing. Null on every ordinary
    // run, which is what keeps a value here meaning the fence fired.
    failure_reason: res.failure_reason ?? null,
    blocked_url: res.blocked_url ?? null,
    has_recording: !!run.recordingFile,
    // A PDF can only link a recording that has a public address; without one
    // the report says "recorded" and the app serves the video itself.
    recording_url:
      run.recordingFile && PUBLIC_BASE_URL
        ? `${PUBLIC_BASE_URL}/api/runs/${run.id}/recording`
        : null,
    generated_at: new Date().toISOString(),
    steps: stepsOf(run),
    // US-044: what the browser said while this run was failing. Bounded by the
    // agent's per-step cap, so this stays a section and not an archive — the
    // archive is the opt-in HAR beside it.
    ...diagnosticsOf(run),
  };
  const dataPath = path.join(runDir, REPORT_DATA_FILENAME);
  const pdfPath = path.join(runDir, 'report.pdf');
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

  // 'none' rather than 'error': no report was asked for, so nothing failed.
  // The notify call is the one the renderer's `close` would have made — without
  // it a mail that waits on the report waits for a process that never spawns.
  if (!REPORTS_ENABLED) {
    run.reportStatus = 'none';
    persistUpdate(run);
    maybeNotify(run);
    return;
  }

  const child = spawn(PYTHON_BIN, [REPORT_SCRIPT, dataPath, pdfPath]);
  child.stderr.on('data', (d) => process.stderr.write(`[report ${run.id.slice(0, 8)}] ${d}`));
  child.on('close', (code) => {
    run.reportStatus = code === 0 && fs.existsSync(pdfPath) ? 'ready' : 'error';
    run.reportPath = pdfPath;
    persistUpdate(run);
    console.log(`report ${run.id.slice(0, 8)}: ${run.reportStatus}`);
    maybeNotify(run);
  });
}
