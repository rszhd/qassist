// @ts-check
// Shared harness for the control-plane test files (US-009), split out of the
// former single control-plane.test.js so each surface's tests read on their
// own. Builds the real migrations against an in-memory pg-mem database
// (injected into db.js before the app loads) and returns the app plus the
// fixtures the tests drive it with. Indexes are stripped (runMigrations
// skipIndexes) because pg-mem's partial-index support returns wrong results.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';
import { registerDecode, seedStoredKey } from './stored-key.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

async function pollUntil(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Fresh app + pg-mem DB + fixtures for one control-plane test file. Each file
 * calls this in its own `before`, so the four files run isolated — node --test
 * gives each file its own process, hence its own env and database.
 */
export async function createHarness() {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-cp-test-'));
  // Config is read at import time, so env must be set before importing.
  process.env.WORKER_API_TOKEN = TOKEN;
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, '..', 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, '..', 'stubs', 'fake_report.js');
  // Reports are opt-in (REPORTS_ENABLED, default off); the harness renders them
  // so a suite can assert on the PDF. reports-disabled.test.js covers the default.
  process.env.REPORTS_ENABLED = '1';
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
  // Real-Postgres builtin that pg-mem lacks (used by PUT /api/tests/:id).
  mem.public.registerFunction({
    name: 'nullif',
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (a, b) => (a === b ? null : a),
  });
  registerDecode(mem);
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();

  const { runMigrations, initDb, getOperatorUserId } = await import('../../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  const operatorId = getOperatorUserId();
  // BYOK-only (US-039): run creation is gated on the caller's stored key.
  await seedStoredKey(pool, /** @type {string} */ (operatorId));
  const { app } = await import('../../src/server.js');
  const { sweepArtifacts } = await import('../../src/retention.js');

  const makeTest = (overrides = {}) =>
    request(app)
      .post('/api/tests')
      .set(auth)
      .send({
        name: 'login smoke',
        goal: 'log in and see the dashboard',
        start_url: 'https://example.com',
        ...overrides,
      });

  const makeProject = async (name) =>
    (await request(app).post('/api/projects').set(auth).send({ name }).expect(201)).body;

  /** An artifact dir with a report + recording in it, last written `ageDays` ago. */
  const makeArtifacts = (id, ageDays) => {
    const dir = path.join(artifactsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.pdf'), 'pdf');
    fs.writeFileSync(path.join(dir, 'recording.mp4'), 'mp4');
    const at = new Date(Date.now() - ageDays * 86400_000);
    fs.utimesSync(dir, at, at);
    return dir;
  };

  return {
    app, pool, auth, operatorId, sweepArtifacts, artifactsDir,
    pollUntil, makeTest, makeProject, makeArtifacts,
  };
}
