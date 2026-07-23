// Replays a recorded NDJSON transcript through the real run engine, no browser
// (US-034). Points AGENT_SCRIPT here and QA_REPLAY_TRANSCRIPT at a fixture; the
// engine parses the lines and makes its actual pass/fail decision. Lines are
// emitted verbatim, so the fixture is the contract. If the transcript announces
// a recording, the referenced file is created first — the real agent writes it
// before the 'recording' event, and the recording-serving path expects it.
import fs from 'node:fs';
import path from 'node:path';

const runDir = path.join(process.env.ARTIFACTS_DIR, process.env.QA_RUN_ID);
fs.mkdirSync(runDir, { recursive: true });

const transcript = fs.readFileSync(process.env.QA_REPLAY_TRANSCRIPT, 'utf8');
const lines = transcript.split('\n').filter((l) => l.trim());

for (const line of lines) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    evt = null;
  }
  if (evt?.type === 'recording' && evt.file) {
    fs.writeFileSync(path.join(runDir, evt.file), 'fake mp4 for tests\n');
  }
  process.stdout.write(line + '\n');
}
process.exit(0);
