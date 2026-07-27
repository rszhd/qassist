// Stand-in for agent/run_agent.py for the US-043 assertions.
//
// Two jobs. It records what the spawn actually handed it — which env vars, and
// crucially whether QA_STORAGE_STATE names a FILE THAT EXISTS rather than a
// JSON blob or a stringified object, since a dict silently loads nothing in
// browser-use (see session-blob.test.js, D1). And it drives the run to whichever
// ending the test asked for, spelled in QA_GOAL because that is the one field a
// test can set on a saved test row without inventing a channel.
//
// The capture file goes to QA_CAPTURE_DIR, deliberately outside ARTIFACTS_DIR
// and SESSIONS_DIR: it is the test's instrument, not a product artifact, and a
// canary assertion that swept the run directory would otherwise find the blob
// this stub wrote there itself.
import fs from 'node:fs';
import path from 'node:path';

const goal = process.env.QA_GOAL || '';
const runId = process.env.QA_RUN_ID || 'unknown';
const statePath = process.env.QA_STORAGE_STATE || '';

if (process.env.QA_CAPTURE_DIR) {
  let isFile = false;
  let contents = '';
  try {
    isFile = !!statePath && fs.statSync(statePath).isFile();
    contents = isFile ? fs.readFileSync(statePath, 'utf8') : '';
  } catch {
    /* leaves isFile false, which is what the assertion is about */
  }
  fs.writeFileSync(
    path.join(process.env.QA_CAPTURE_DIR, `${runId}.json`),
    JSON.stringify({
      QA_STORAGE_STATE: statePath,
      QA_STORAGE_STATE_OUT: process.env.QA_STORAGE_STATE_OUT || '',
      QA_INITIAL_ACTIONS: process.env.QA_INITIAL_ACTIONS,
      QA_SESSION_VERIFY: process.env.QA_SESSION_VERIFY,
      storage_state_is_file: isFile,
      storage_state_contents: contents,
    })
  );
}

const emit = (evt) => process.stdout.write(JSON.stringify(evt) + '\n');

// A hung agent, for the stop and watchdog-kill assertions: there has to be a
// live process group for either of them to have anything to act on.
if (goal === 'HANG') {
  emit({ type: 'start', goal, start_url: process.env.QA_START_URL });
  setInterval(() => {}, 1000);
  // Honour the stop the way the real agent does — browser-use returns its
  // history out of Agent.stop() and the process exits normally, which is the
  // path teardown has to cover. The SIGKILL backstop is exercised separately by
  // the test killing the group itself.
  process.stdin.on('data', (chunk) => {
    if (String(chunk).includes('"stop"')) process.exit(0);
  });
} else if (goal === 'SESSION_EXPIRED') {
  // What the real agent emits when its pre-LLM check finds the session no
  // longer authenticates anybody. A `done` with success:false, not an `error`:
  // an expired session is a FAILED run carrying a reason, the same shape
  // US-042 gives a fenced one — `error` would make it a crash, which is a
  // US-012 alert and a red CI build for something that is merely stale.
  emit({
    type: 'done',
    success: false,
    duration_seconds: 0.1,
    steps: 0,
    failure_reason: 'session_expired',
    final_result: 'the saved session is no longer signed in — refresh it',
  });
  process.exit(0);
} else {
  // The LLM loop starts at 1: browser-use records initial actions as step 0.
  emit({ type: 'step', step: 1, elapsed: 0.1, url: process.env.QA_START_URL, next_goal: 'look' });

  const passed = goal !== 'FAIL';
  // The real agent snapshots the browser's storage state at the end of EVERY
  // step, whatever the run then does — `agent.run()` closes the browser in its
  // own finally, so there is no "on the way out" left to do it in. So the stub
  // writes it unconditionally too, and the assertion that a FAILING login run
  // leaves the stored session alone therefore tests the SERVER's gate rather
  // than the stub's manners. Written the other way it passed vacuously.
  if (process.env.QA_STORAGE_STATE_OUT) {
    fs.mkdirSync(path.dirname(process.env.QA_STORAGE_STATE_OUT), { recursive: true });
    fs.writeFileSync(
      process.env.QA_STORAGE_STATE_OUT,
      JSON.stringify({
        cookies: [
          {
            name: 'session',
            value: 'FRESHLY-CAPTURED-BY-THE-LOGIN-RUN',
            domain: '.example.test',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      })
    );
  }

  emit({
    type: 'done',
    success: passed,
    duration_seconds: 0.1,
    steps: 1,
    final_result: passed ? 'goal met (stub)' : 'goal not met (stub)',
  });
  process.exit(0);
}
