// @ts-check
// Demo sandbox total-tenant cap (US-036 step 5). The provision endpoint is
// public and writable, so it rejects with 503 once DEMO_MAX_TENANTS live tenants
// exist rather than growing unbounded between reaper passes. Cap set low and the
// per-IP throttle left high so the cap is the guard that fires (in one process
// the smaller of the two limits always wins). Boundary is off-by-one-prone: the
// Nth mint must succeed and the (N+1)th must fail.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoHarness, newAgent } from './helpers/demo-sandbox.js';

const MAX = 3;

/** @type {import('express').Express} */
let app;

before(async () => {
  ({ app } = await createDemoHarness({ maxTenants: MAX, ipMax: 1000 }));
});

test('mints up to the cap, then 503s past it, and a returning cookie is unaffected', async () => {
  const visitors = [];
  for (let i = 0; i < MAX; i++) {
    const agent = newAgent(app);
    await agent.post('/api/demo/session').expect(201);
    visitors.push(agent);
  }

  // Cap reached: a brand-new visitor is rejected, not seeded.
  const rejected = await newAgent(app).post('/api/demo/session').expect(503);
  assert.ok(rejected.headers['retry-after'], 'sets Retry-After');

  // The returning-cookie shortcut is past the guard: an existing tenant still
  // gets its session back even at capacity.
  const back = await visitors[0].post('/api/demo/session').expect(200);
  assert.ok(back.body.expiresAt);
});
