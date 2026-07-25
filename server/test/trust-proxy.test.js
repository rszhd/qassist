// @ts-check
// TRUST_PROXY parse (US-040) — correctness-critical, assertion-first.
//
// This one value decides *whose* address every per-IP guard in the app counts,
// and both directions are a live failure:
//
//   unset behind a proxy — req.ip is the proxy container's on every request, so
//     DEMO_IP_MAX stops being per-visitor and becomes a deployment-wide cap. The
//     demo greets its sixth visitor of the hour with "too many sandboxes from
//     this address".
//   trusted on a directly-reachable stack — a plain `docker compose up` self-host
//     publishes 8080, and honouring X-Forwarded-For there lets any client claim
//     any address and mint past the per-IP cap.
//
// So the default is false (count the socket), and a deployment behind a proxy
// opts in with the number of hops it actually has. The behavioural half — that
// the throttle then counts the right address — is in demo-ip-throttle.test.js
// (untrusted) and demo-ip-throttle-proxy.test.js (one hop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrustProxy } from '../src/config.js';

test('unset, blank or explicitly off means trust nothing', () => {
  // The self-host default, and the one that must never be an accident: an app
  // reachable on its own port treats X-Forwarded-For as user input.
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('   '), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('off'), false);
  assert.equal(parseTrustProxy('no'), false);
  assert.equal(parseTrustProxy('0'), 0, 'zero hops is Express for "trust nothing"');
});

test('a hop count stays a number, not the string "1" or boolean true', () => {
  // The distinction Express cares about and the one easiest to fumble: `1` means
  // "trust the last hop", `true` means "trust every hop, including the client's
  // own header". Our deployment has exactly one proxy in front of it.
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy(' 1 '), 1);
});

test('true is honoured but only when written out', () => {
  // Reachable on purpose (some setups genuinely front the app with a chain they
  // control), never by typo — which is why "1" above does not land here.
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('TRUE'), true);
});

test('anything else is passed through for Express to interpret', () => {
  // Subnet lists and Express's own keywords are the escape hatch for a box whose
  // proxy chain isn't a simple hop count.
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12'), '10.0.0.0/8, 172.16.0.0/12');
});

test('a value that is neither a number nor a keyword never silently becomes true', () => {
  // The failure this closes: a fat-fingered value that parses as truthy would
  // turn every self-host into one that believes X-Forwarded-For. It goes to
  // Express as the string it is, where an address list that means nothing is
  // rejected outright at boot — loud is the safe direction here, silently
  // trusting is not.
  const parsed = parseTrustProxy('yes-please');
  assert.notEqual(parsed, true);
  assert.equal(typeof parsed, 'string');
});
