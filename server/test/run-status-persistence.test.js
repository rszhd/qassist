// @ts-check
// BUG-001: a running run must not be left persisted as `queued`.
//
// The run row is written by two fire-and-forget queries against the pool — the
// `queued` INSERT in createRun, then the `running` UPDATE in startRun, fired
// back-to-back. They must reach the DB in that order; if the UPDATE can race
// ahead of the INSERT it matches zero rows and the row stays `queued` until the
// run finishes, which is what History showed.
//
// pg-mem resolves queries deterministically and never reproduces the race, so
// this guards the *invariant* directly rather than the timing: with the insert
// held open, the running UPDATE must not have been issued yet. The buggy code
// issues that UPDATE synchronously inside createRun; the fix chains it behind
// the insert's promise, so holding the insert holds the update.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newDb, DataType } from 'pg-mem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {typeof import('../src/runs.js')} */
let engine;
/** @type {any} */
let pool;
/** Every query the engine issues, in call order: 'insert' or {update: <status>}. */
const calls = [];
/** @type {(value?: unknown) => void} */
let releaseInsert;
/** Held until releaseInsert() so the running UPDATE has an unresolved insert to race. */
let insertGate;

before(async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-bug001-'));
  process.env.QA_STUB_HOLD_MS = '300'; // run stays in flight past the assertions
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, 'stubs', 'fake_report.js');
  process.env.ARTIFACTS_DIR = artifactsDir;

  const mem = newDb();
  mem.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      implementation: () => randomUUID(),
      impure: true,
    });
  });
  const { Pool } = mem.adapters.createPg();
  pool = new Pool();

  const { runMigrations, initDb } = await import('../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);

  // Wrap the live pool: record runs-table writes in the order they are issued,
  // and stall the runs INSERT until the test releases it.
  insertGate = new Promise((resolve) => {
    releaseInsert = resolve;
  });
  const orig = pool.query.bind(pool);
  pool.query = (text, params) => {
    if (/insert into runs\b/i.test(text)) {
      calls.push('insert');
      return insertGate.then(() => orig(text, params));
    }
    if (/update runs\b/i.test(text)) calls.push({ update: params?.[1] });
    return orig(text, params);
  };

  engine = await import('../src/runs.js');
});

async function pollUntil(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a starting run does not persist its running UPDATE before the queued INSERT commits', async () => {
  const run = /** @type {import('../src/runState.js').Run} */ (
    engine.createRun({ goal: 'record status', start_url: 'https://example.test', max_steps: 1 })
  );
  assert.equal(run.status, 'running'); // in memory it has started

  // The INSERT is still stalled, so the running UPDATE must not have been
  // issued — chaining it behind the insert is the whole fix.
  assert.deepEqual(
    calls,
    ['insert'],
    'running UPDATE was issued while the queued INSERT was still pending'
  );

  releaseInsert();

  // Once the insert commits the UPDATE follows, and the first one carries
  // `running` — the row is never left at `queued` while the run executes.
  await pollUntil(() => calls.some((c) => typeof c === 'object'));
  const firstUpdate = calls.find((c) => typeof c === 'object');
  assert.deepEqual(firstUpdate, { update: 'running' });

  const row = await pollUntil(async () => {
    const r = await pool.query('select status from runs where id = $1', [run.id]);
    return r.rows[0] || null;
  });
  assert.equal(row.status, 'running');

  await pollUntil(() => engine.TERMINAL.has(run.status));
});
