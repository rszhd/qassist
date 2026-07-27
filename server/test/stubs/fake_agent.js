// Stand-in for agent/run_agent.py in tests: emits the same NDJSON protocol
// (step events, a recording, then a done verdict) and exits, no browser
// involved. The recording is a stub file in the run dir, as the real agent
// writes it before announcing it.
import fs from 'node:fs';
import path from 'node:path';

// US-042: the navigation fence is only real if its settings reach the child —
// an agent spawned without them runs an unfenced browser while every
// server-side assertion stays green. Dumped as JSON so a test can tell an
// absent variable from an empty one. Lives here rather than in
// env_capture_agent.js because AGENT_SCRIPT is import-time config: a test can
// only change what the child DOES via a per-run env var, not which file runs.
if (process.env.QA_ENV_CAPTURE_FILE) {
  const keys = ['QA_BLOCK_PRIVATE_NETWORKS', 'QA_DENIED_HOSTS', 'QA_ALLOWED_DOMAINS'];
  fs.writeFileSync(
    process.env.QA_ENV_CAPTURE_FILE,
    JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k]])))
  );
}

const runDir = path.join(process.env.ARTIFACTS_DIR, process.env.QA_RUN_ID);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'recording.mp4'), 'fake mp4 for tests\n');

// QA_STUB_FAIL flips the verdict, so a test can exercise what a failing run
// triggers (US-012's email) without a browser that actually fails.
const failed = process.env.QA_STUB_FAIL === '1';

const events = [
  { type: 'step', step: 1, elapsed: 0.1, next_goal: 'open page', evaluation: null, url: process.env.QA_START_URL, screenshot_file: null },
  { type: 'recording', file: 'recording.mp4', frames: 3 },
  {
    type: 'done',
    success: !failed,
    duration_seconds: 0.2,
    steps: 1,
    final_result: failed ? 'goal not met (stub)' : 'goal met (stub)',
  },
];
function emit() {
  for (const evt of events) process.stdout.write(JSON.stringify(evt) + '\n');
  process.exit(0);
}

// QA_STUB_HOLD_MS keeps a run in its slot long enough for the queue behind it
// to be observed (queue.test.js); unset, the stub finishes at once. A per-run
// `hold=<ms>` in the goal overrides it, so a test can free ONE specific slot
// while others stay busy (concurrency-fairshare.test.js's dequeue case).
const perRun = /\bhold=(\d+)/.exec(process.env.QA_GOAL || '');
const holdMs = perRun ? Number(perRun[1]) : Number(process.env.QA_STUB_HOLD_MS || 0);

if (holdMs) {
  // Express writes control lines to our stdin, one JSON object per line, as it
  // does to the real agent: {"cmd":"screencast"} (ignored here) and — US-047 —
  // {"cmd":"stop"}. `stop=ignore` in the goal is the *wedged* agent that never
  // honours it, which is the case the escalation to killRunTree exists for.
  // Otherwise the stub does what browser-use does after Agent.stop(): returns
  // its partial evidence and exits cleanly, verdict and all. That the verdict
  // says success is the point — a stopped run must not inherit it.
  const wedged = /\bstop=ignore\b/.test(process.env.QA_GOAL || '');
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.cmd === 'stop' && !wedged) emit();
    }
  });
  // Announce that we are up and reading stdin, so a test that wants to stop a
  // *running* agent can wait for that rather than racing process startup — on a
  // loaded box `node` can take longer to boot than a short stop grace window,
  // which silently turns a graceful-stop test into an escalation test.
  process.stdout.write(JSON.stringify({ type: 'log', message: 'stub ready' }) + '\n');
  setTimeout(emit, holdMs);
} else {
  emit();
}
