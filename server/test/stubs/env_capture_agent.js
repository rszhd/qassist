// Stand-in for agent/run_agent.py that records which OPENAI_API_KEY it was
// spawned with, so a test can prove the resolved BYOK key reached the child env
// — and only there. Writes the received key to the path in QA_CAPTURE_FILE
// (deliberately OUTSIDE the run/artifacts dir: it is the test's instrument, not
// a product artifact), then emits the normal done protocol.
import fs from 'node:fs';

if (process.env.QA_CAPTURE_FILE) {
  fs.writeFileSync(process.env.QA_CAPTURE_FILE, process.env.OPENAI_API_KEY || '');
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
