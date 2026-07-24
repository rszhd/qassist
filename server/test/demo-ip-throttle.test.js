// @ts-check
// Demo sandbox per-IP mint throttle (US-036 step 5). One source address can mint
// at most DEMO_IP_MAX tenants per window, so a single caller can't drain the
// total cap. IP max set low and the total cap left high so the throttle is the
// guard that fires. All supertest requests share the loopback source IP, so they
// share one quota. A returning cookie never reaches the limiter (it short-
// circuits earlier), and only a successful mint records a hit.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoHarness, newAgent } from './helpers/demo-sandbox.js';

const IP_MAX = 2;

/** @type {import('express').Express} */
let app;

before(async () => {
  ({ app } = await createDemoHarness({ maxTenants: 1000, ipMax: IP_MAX }));
});

test('throttles fresh mints from one IP but not a returning tenant', async () => {
  const first = newAgent(app);
  await first.post('/api/demo/session').expect(201); // mint 1
  await newAgent(app).post('/api/demo/session').expect(201); // mint 2 (== IP_MAX)

  // Third distinct visitor from the same IP is throttled, not seeded.
  const throttled = await newAgent(app).post('/api/demo/session').expect(429);
  assert.ok(throttled.headers['retry-after'], 'sets Retry-After');

  // A visitor already holding a valid cookie is unaffected — it returns its
  // session without touching the mint limiter.
  const back = await first.post('/api/demo/session').expect(200);
  assert.ok(back.body.expiresAt);
});
