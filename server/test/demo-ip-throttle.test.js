// @ts-check
// Demo sandbox per-IP mint throttle (US-036 step 5). One source address can mint
// at most DEMO_IP_MAX tenants per window, so a single caller can't drain the
// total cap. IP max set low and the total cap left high so the throttle is the
// guard that fires. All supertest requests share the loopback source IP, so they
// share one quota. A returning cookie never reaches the limiter (it short-
// circuits earlier), and only a successful mint records a hit.
//
// TRUST_PROXY is unset here — the self-host default, where the app is reachable
// on its own port and X-Forwarded-For is a header a stranger can type. The
// same throttle behind a proxy is demo-ip-throttle-proxy.test.js (US-040).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
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

test('X-Forwarded-For buys nothing when no proxy is trusted', async () => {
  // Runs after the test above, which has already spent loopback's quota. A
  // caller inventing an address would get a fresh one if the header were
  // believed — 429 is the proof that it isn't, and that a self-host published
  // on its own port cannot be walked past with a header (US-040).
  const invented = await request(app)
    .post('/api/demo/session')
    .set('X-Forwarded-For', '203.0.113.7')
    .expect(429);
  assert.ok(invented.headers['retry-after'], 'sets Retry-After');

  // Nor does a chain, which is what the header really looks like in the wild.
  await request(app)
    .post('/api/demo/session')
    .set('X-Forwarded-For', '198.51.100.4, 192.0.2.55')
    .expect(429);
});
