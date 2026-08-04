// @ts-check
// Shared harness for the AUTH_MODE=demo sandbox tests (US-036). Builds the real
// migrations against an in-memory pg-mem database and returns the app in demo
// mode. Caps are parameters because config is read at import time, so the cap
// (503) and per-IP throttle (429) guards each need their own process with the
// smaller limit set — in one process the smaller of the two always fires first.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { newDb, DataType } from 'pg-mem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fresh app + pg-mem DB in AUTH_MODE=demo. Env is set before importing server
 * (config reads at import time), so callers pass the caps they want to exercise.
 * @param {{ maxTenants?: number, ipMax?: number, trustProxy?: string }} [caps]
 */
export async function createDemoHarness({ maxTenants, ipMax, trustProxy } = {}) {
  process.env.AUTH_MODE = 'demo';
  process.env.SESSION_SECRET = 'demo-session-secret-0123456789';
  delete process.env.AUTH_ENABLED;
  delete process.env.WORKER_API_TOKEN;
  process.env.PYTHON_BIN = process.execPath;
  process.env.AGENT_SCRIPT = path.join(__dirname, '..', 'stubs', 'fake_agent.js');
  process.env.REPORT_SCRIPT = path.join(__dirname, '..', 'stubs', 'fake_report.js');
  process.env.REPORTS_ENABLED = '1';
  process.env.ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qassist-demo-'));
  if (maxTenants != null) process.env.DEMO_MAX_TENANTS = String(maxTenants);
  if (ipMax != null) process.env.DEMO_IP_MAX = String(ipMax);
  // Deleted rather than left alone: whether X-Forwarded-For is believed is the
  // difference between a per-visitor throttle and a deployment-wide one, so no
  // test may inherit it from the ambient environment (US-040).
  if (trustProxy != null) process.env.TRUST_PROXY = trustProxy;
  else delete process.env.TRUST_PROXY;

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
  const pool = new Pool();

  const { runMigrations, initDb } = await import('../../src/db.js');
  await runMigrations(pool, { skipIndexes: true });
  await initDb(pool);
  const { app } = await import('../../src/server.js');
  return { app, pool };
}

/** A fresh cookie-persisting visitor (its own session cookie, same source IP). */
export function newAgent(app) {
  return request.agent(app);
}
