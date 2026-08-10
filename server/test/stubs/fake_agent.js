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
  // US-048 rides the same instrument for the same reason: the fixture whitelist
  // is only real if it reaches the child, and a run spawned without it attaches
  // nothing while every server-side assertion stays green.
  // US-044 rides it a third time: HAR capture is opt-in, so the only proof that
  // "off" and "on" are different runs is which flag the child was handed.
  const keys = [
    'QA_BLOCK_PRIVATE_NETWORKS',
    'QA_DENIED_HOSTS',
    'QA_ALLOWED_DOMAINS',
    'QA_FIXTURES',
    'QA_HAR',
    // US-046 rides it a fourth time: cost collection is the one flag whose
    // "off" has to mean no outbound request, and the only proof the server's
    // switch decided that is which value the child was handed.
    'QA_CALCULATE_COST',
    // US-081 rides it a fifth time, and needs the absent/empty distinction this
    // file exists for more than any of them: an ad-hoc run's spawn must be
    // identical to one from before the story shipped, so `QA_MEMORY=""` is a
    // failure no server-side assertion can see. A key missing from this list is
    // captured as `undefined`, which JSON.stringify drops — so an assertion
    // about absence is only real once the key is named here.
    'QA_MEMORY',
    'QA_LEARN_MEMORY',
  ];
  fs.writeFileSync(
    process.env.QA_ENV_CAPTURE_FILE,
    JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k]])))
  );
}

const runDir = path.join(process.env.ARTIFACTS_DIR, process.env.QA_RUN_ID);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'recording.mp4'), 'fake mp4 for tests\n');

// The real agent writes the HAR itself (BrowserProfile.record_har_path), so the
// stub's job is only to prove the flag decided whether a file appears (US-044).
if (process.env.QA_HAR === '1') {
  fs.writeFileSync(
    path.join(runDir, 'network.har'),
    JSON.stringify({ log: { version: '1.2', entries: [] } })
  );
}

// QA_STUB_FAIL flips the verdict, so a test can exercise what a failing run
// triggers (US-012's email) without a browser that actually fails.
const failed = process.env.QA_STUB_FAIL === '1';

// US-044: the evidence events, emitted only when a test asks for them — most
// runs have nothing to report and the empty case is the normal one. Batched per
// step boundary exactly as the real agent batches them, and `dropped` carries the
// run total so far, which is what stops the server summing it per event.
const diagnosticEvents =
  process.env.QA_STUB_DIAGNOSTICS === '1'
    ? [
        {
          type: 'diagnostics',
          dropped: 3,
          entries: [
            { kind: 'request', step: 1, url: 'https://api.example.com/cart', status: 500, error: null, count: 2 },
            { kind: 'console', step: 1, level: 'error', text: 'TypeError: x is not a function', count: 7 },
          ],
        },
        {
          type: 'diagnostics',
          dropped: 5,
          entries: [{ kind: 'exception', step: 2, text: 'Error: submit handler died', count: 1 }],
        },
      ]
    : [];

// US-081: what this run's generator concluded, emitted only when the server told
// the run it may learn. The stub does not decide eligibility — the server does,
// and honouring `QA_LEARN_MEMORY` here is what makes the flag's absence provable
// end to end rather than only at the spawn. Contents come from the test, because
// what a notebook says is `agent/run_memory.py`'s subject, not this file's.
const memoryEvents =
  process.env.QA_LEARN_MEMORY === '1' && process.env.QA_STUB_MEMORY
    ? [{ type: 'memory', learned: JSON.parse(process.env.QA_STUB_MEMORY) }]
    : [];

const events = [
  { type: 'step', step: 1, elapsed: 0.1, next_goal: 'open page', evaluation: null, url: process.env.QA_START_URL, screenshot_file: null },
  ...diagnosticEvents,
  { type: 'recording', file: 'recording.mp4', frames: 3 },
  ...memoryEvents,
  {
    type: 'done',
    success: !failed,
    duration_seconds: 0.2,
    steps: 1,
    final_result: failed ? 'goal not met (stub)' : 'goal met (stub)',
    // US-046: whatever the test wants `agent/run_cost.py` to have concluded.
    // Absent unless asked for, because a run that reports no usage at all is
    // the normal case for everything that predates the story and has to keep
    // working — and `undefined` here drops the key, which is the shape the
    // server must treat as "nobody measured".
    usage: process.env.QA_STUB_USAGE ? JSON.parse(process.env.QA_STUB_USAGE) : undefined,
  },
];
function emit() {
  for (const evt of events) process.stdout.write(JSON.stringify(evt) + '\n');
  process.exit(0);
}

// QA_STUB_HOLD_MS keeps a run in its slot long enough for the queue behind it
// to be observed (queue.test.js); unset, the stub finishes at once. A per-run
// `hold=<ms>` in the goal overrides it, so a test can free ONE specific slot
// while others stay busy.
//
// `release=<name>` is the same idea said exactly: hold until the file
// QA_STUB_RELEASE_DIR/<name> appears, however long that takes. A duration
// answers "which slot frees first" with a race the test can only win while the
// box is idle — that was BUG-007's fair-share failure, decided by 200ms in an
// 8s budget. A run that has not spawned yet can still be named, which is why
// this is a file and not a line on our stdin.
//
// The file named `all` frees every held run, so an afterEach can drain a test
// that failed before it got to its own release calls rather than hanging on it.
const releaseName = /\brelease=([\w.-]+)/.exec(process.env.QA_GOAL || '');
const perRun = /\bhold=(\d+)/.exec(process.env.QA_GOAL || '');
const holdMs = releaseName
  ? 0
  : perRun
    ? Number(perRun[1])
    : Number(process.env.QA_STUB_HOLD_MS || 0);
const RELEASE_POLL_MS = 10;
const RELEASE_ALL = 'all';

if (holdMs || releaseName) {
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
      // US-079: the pause/hint/resume trio changes nothing about how the stub
      // behaves — every window under test is a server-side timer, and a stub
      // that also held its own clock would let an assertion pass because the
      // agent happened to exit first. Echoed so a test can prove the line
      // reached the child at all, which is the only part the server cannot see.
      if (msg.cmd === 'pause' || msg.cmd === 'resume') {
        process.stdout.write(JSON.stringify({ type: 'log', message: `stub ${msg.cmd}` }) + '\n');
      }
      if (msg.cmd === 'hint') {
        process.stdout.write(
          JSON.stringify({ type: 'log', message: `stub hint: ${msg.text}` }) + '\n'
        );
      }
      if (msg.cmd === 'stop' && !wedged) emit();
    }
  });
  // Announce that we are up and reading stdin, so a test that wants to stop a
  // *running* agent can wait for that rather than racing process startup — on a
  // loaded box `node` can take longer to boot than a short stop grace window,
  // which silently turns a graceful-stop test into an escalation test.
  process.stdout.write(JSON.stringify({ type: 'log', message: 'stub ready' }) + '\n');
  if (releaseName) {
    const dir = process.env.QA_STUB_RELEASE_DIR;
    const freed = [path.join(dir, releaseName[1]), path.join(dir, RELEASE_ALL)];
    const watch = setInterval(() => {
      if (!freed.some((flag) => fs.existsSync(flag))) return;
      clearInterval(watch);
      emit();
    }, RELEASE_POLL_MS);
  } else {
    setTimeout(emit, holdMs);
  }
} else {
  emit();
}
