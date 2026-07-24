// A canary for the US-036 no-cost assertion: stand-in for run_agent.py /
// make_report.py that records the mere fact it was ever spawned. In demo mode
// the interceptor must replay a fixture instead of spawning Python, so this file
// must never run — the test asserts CANARY_FILE stays absent. Writing the marker
// is the whole job; it emits no events and exits immediately.
import fs from 'node:fs';

const file = process.env.CANARY_FILE;
if (file) fs.appendFileSync(file, `spawned ${process.argv.slice(2).join(' ')}\n`);
