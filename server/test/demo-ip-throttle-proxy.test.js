// @ts-check
// The demo's per-IP mint throttle BEHIND A PROXY (US-040) — the other half of
// demo-ip-throttle.test.js, and the reason that file passing was never proof.
//
// Every supertest request shares one socket address, which is exactly what a
// Traefik-fronted deployment looks like from Express: with `trust proxy` unset,
// req.ip is the proxy's for every visitor and DEMO_IP_MAX silently becomes a cap
// on the whole deployment. That is the bug this file exists to keep out — the
// demo's entire purpose is that a stranger can walk in, and the sixth stranger
// of the hour was meeting "too many sandboxes from this address".
//
// TRUST_PROXY=1: one hop, which is what our box has. Its own process because
// config is read at import time.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createDemoHarness } from './helpers/demo-sandbox.js';

const IP_MAX = 2;

/** @type {import('express').Express} */
let app;

before(async () => {
  ({ app } = await createDemoHarness({ maxTenants: 1000, ipMax: IP_MAX, trustProxy: '1' }));
});

/** One mint attempt from a given client address, as the proxy would present it. */
function mintFrom(clientIp) {
  return request(app).post('/api/demo/session').set('X-Forwarded-For', clientIp);
}

test('each visitor gets their own quota, not a share of one', async () => {
  await mintFrom('203.0.113.7').expect(201);
  await mintFrom('203.0.113.7').expect(201); // == IP_MAX for that address
  await mintFrom('203.0.113.7').expect(429);

  // The assertion the whole story turns on: one address exhausting its quota
  // must not close the door on everyone else. Unset TRUST_PROXY and this is the
  // line that fails, because both visitors are the proxy.
  await mintFrom('198.51.100.4').expect(201);
  await mintFrom('198.51.100.4').expect(201);
  await mintFrom('198.51.100.4').expect(429);

  // And a third, after two addresses are already exhausted.
  await mintFrom('192.0.2.55').expect(201);
});

test('a client cannot escape its quota by claiming an address', async () => {
  // With one hop trusted, the counted address is the one the *proxy* appended —
  // the rightmost entry — not the prefix the client wrote for itself. So a
  // visitor at 192.0.2.99 spraying invented addresses still spends one quota.
  const spoofed = (claim) =>
    request(app).post('/api/demo/session').set('X-Forwarded-For', `${claim}, 192.0.2.99`);

  await spoofed('1.1.1.1').expect(201);
  await spoofed('2.2.2.2').expect(201); // == IP_MAX for 192.0.2.99
  const blocked = await spoofed('3.3.3.3').expect(429);
  assert.ok(blocked.headers['retry-after'], 'sets Retry-After');
});
