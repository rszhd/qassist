// Stand-in for agent/run_agent.py that records the QA_VARS it was spawned with
// — the `sensitive_data` channel a secret variable's real value travels on
// (US-035) — so a test can prove a STORED secret (US-064) reaches the child and
// nothing else. Appends one JSON line per run to QA_CAPTURE_FILE, deliberately
// outside the run/artifacts dir: it is the test's instrument, not an artifact.
import fs from 'node:fs';

if (process.env.QA_CAPTURE_FILE) {
  fs.appendFileSync(
    process.env.QA_CAPTURE_FILE,
    JSON.stringify({ vars: process.env.QA_VARS || '', goal: process.env.QA_GOAL || '' }) + '\n'
  );
}

process.stdout.write(
  JSON.stringify({
    type: 'done',
    success: true,
    duration_seconds: 0.1,
    steps: 1,
    final_result: 'goal met (stub)',
  }) + '\n'
);
process.exit(0);
