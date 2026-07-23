// Stand-in for agent/run_agent.py in tests: emits the same NDJSON protocol
// (step events, a recording, then a done verdict) and exits, no browser
// involved. The recording is a stub file in the run dir, as the real agent
// writes it before announcing it.
import fs from 'node:fs';
import path from 'node:path';

const runDir = path.join(process.env.ARTIFACTS_DIR, process.env.QA_RUN_ID);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'recording.mp4'), 'fake mp4 for tests\n');

const events = [
  { type: 'step', step: 1, elapsed: 0.1, next_goal: 'open page', evaluation: null, url: process.env.QA_START_URL, screenshot_file: null },
  { type: 'recording', file: 'recording.mp4', frames: 3 },
  { type: 'done', success: true, duration_seconds: 0.2, steps: 1, final_result: 'goal met (stub)' },
];
function emit() {
  for (const evt of events) process.stdout.write(JSON.stringify(evt) + '\n');
  process.exit(0);
}

// QA_STUB_HOLD_MS keeps a run in its slot long enough for the queue behind it
// to be observed (queue.test.js); unset, the stub finishes at once.
const holdMs = Number(process.env.QA_STUB_HOLD_MS || 0);
if (holdMs) setTimeout(emit, holdMs);
else emit();
