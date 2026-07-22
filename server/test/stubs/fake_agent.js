// Stand-in for agent/run_agent.py in tests: emits the same NDJSON protocol
// (step events then a done verdict) and exits, no browser involved.
const events = [
  { type: 'step', step: 1, elapsed: 0.1, next_goal: 'open page', evaluation: null, url: process.env.QA_START_URL, screenshot_file: null },
  { type: 'done', success: true, duration_seconds: 0.2, steps: 1, final_result: 'goal met (stub)' },
];
for (const evt of events) process.stdout.write(JSON.stringify(evt) + '\n');
process.exit(0);
