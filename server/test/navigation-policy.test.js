// @ts-check
// US-042 — assertion-first spec, part 1: the PURE policy. Every interesting
// failure in this story is a spelling, so this file is the spelling table and
// nothing else. It runs in-process against `navigationPolicy.js` with no app,
// no database and no browser.
//
// Why a pure module carries the story: the fence has two halves that must agree.
// browser-use's SecurityWatchdog enforces the policy *inside* the browser, and
// it is genuinely thorough — `_is_ip_address` mirrors WHATWG host
// canonicalization through `ipaddress` + `inet_aton`, so decimal, hex, octal,
// percent-encoded and ideographic-dot spellings all resolve (verified against
// the pristine 0.13.6 wheel: the file's sha256 matches its dist-info RECORD, so
// this is upstream behaviour and not a local patch that a rebuild would drop).
// But that half only runs once Chromium is up, and AC #4 says a refused
// start_url must cost neither a row, a slot, nor a key. So we need the same
// judgement in JS, one layer earlier, and the two must not drift.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions these assertions encode. Edit them directly; they
// are the spec, and the implementation is written against whatever this file
// says after you have read it.
//
//   D1  Node's WHATWG `URL` already canonicalizes the whole spelling table
//       before we see it:
//           http://2852039166/            -> 169.254.169.254
//           http://0x7f.1/                -> 127.0.0.1
//           http://%31%36%39.254.169.254/ -> 169.254.169.254
//           http://①⑦②.0.0.1/             -> 172.0.0.1
//       So `isAddressLiteral` tests the CANONICAL hostname, and is small. The
//       assertions below are nonetheless written against the RAW spellings,
//       because that is what fails an implementation that regexes the string it
//       was handed instead of parsing it first. The dotted-quad regex is the
//       obvious wrong answer here and it must not go green.
//
//   D2  The instance floor is TWO settings, not one, and this is the finding
//       that changed the story. browser-use's docstring claims
//       `block_ip_addresses` blocks "all IP-based URLs including localhost and
//       private networks". It does not: `localhost`, `db` and
//       `metadata.google.internal` are hostnames, `_is_ip_address` never
//       resolves, and all three sail through. So `QA_BLOCK_PRIVATE_NETWORKS`
//       covers address literals and a denied-HOSTS list carries the rest — and
//       that list is load-bearing for `localhost` (which is this app's own
//       port), not just for our compose service names.
//       [REVIEW: the default denylist below. It is the one thing here an
//       operator inherits without choosing it.]
//
//   D3  Order: scheme, then address literal, then denied host, then the project
//       allowlist. The floor is checked BEFORE the allowlist, which mirrors
//       SecurityWatchdog (`security_watchdog.py` checks block_ip_addresses at
//       :207, allowed_domains at :216). Note this INVERTS the story's
//       assertion-first note, which predicted "the allowlist wins where both
//       apply". It doesn't — that sentence is about allowed vs prohibited
//       domains. A project allowlist therefore cannot re-open an IP literal,
//       and the assertion is written the way the code actually behaves.
//
//   D4  Scheme is gated to http/https. browser-use returns True unconditionally
//       for `data:` and `blob:` (`security_watchdog.py:196`), so a fence that
//       delegated the scheme question to the browser would have a hole in it.
//       `file:` has no hostname to check and is refused here for the same reason.
//
//   D5  `checkStartUrl` returns `null` when the URL is allowed and
//       `{ error, reason }` when it is not. A machine-readable `reason` because
//       AC #3 wants the block to surface as a `failure_reason` rather than as
//       prose, and because the agent side has to map the same vocabulary. The
//       four reasons are pinned in REASONS below.
//
//   D6  The UNSET path returns null for everything, including the addresses
//       this file spends most of its lines blocking. That is AC #4 — a
//       self-hoster testing http://localhost:3000 is not broken by a default
//       they never chose — and it is asserted here against the same table, so
//       the two halves can never be maintained apart.
//
//   D7  An allowlist entry is matched with the same glob vocabulary browser-use
//       uses for `allowed_domains` (`*.example.com` matches the apex AND its
//       subdomains), because the value we validate here is the value we hand to
//       the profile. Anything else would make the pre-check and the in-browser
//       check disagree about the same string, which is the drift this file exists
//       to prevent.
//
//   D8  `validateAllowlist` is separate from `checkStartUrl` and is the answer
//       to AC #5. When `allowed_domains` is set, SecurityWatchdog returns from
//       the allowlist branch and NEVER consults `prohibited_domains` — so a
//       project whose allowlist contains `db` or `localhost` would defeat the
//       instance floor entirely. The floor is therefore enforced at allowlist
//       WRITE time, and that is what makes AC #5 ("regardless of the IP-literal
//       setting") true rather than hopeful.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAddressLiteral,
  checkStartUrl,
  validateAllowlist,
  DEFAULT_DENIED_HOSTS,
} from '../src/navigationPolicy.js';

/** The floor as an instance runs it with nothing configured (D2). */
const FLOOR = { blockPrivate: true, deniedHosts: DEFAULT_DENIED_HOSTS, allowedDomains: [] };
/** The escape hatch: QA_BLOCK_PRIVATE_NETWORKS=0 and no denylist (D6). */
const OFF = { blockPrivate: false, deniedHosts: [], allowedDomains: [] };

/** The pinned reason vocabulary (D5). */
const REASONS = {
  scheme: 'unsupported_scheme',
  ip: 'blocked_ip_address',
  host: 'blocked_host',
  allowlist: 'not_in_allowed_domains',
  malformed: 'invalid_url',
};

/**
 * Every spelling of an address literal the story names, plus the ones Node's
 * canonicalization revealed while writing this (D1). Each is a URL a fence that
 * pattern-matches the raw string would let through.
 */
const ADDRESS_SPELLINGS = [
  ['dotted quad', 'http://169.254.169.254/latest/meta-data/'],
  ['dotted quad, no path', 'http://169.254.169.254'],
  ['loopback', 'http://127.0.0.1:8080/'],
  ['private range', 'http://10.0.0.5/'],
  ['link-local over https', 'https://169.254.169.254/'],
  ['IPv6 loopback', 'http://[::1]:8080/'],
  ['IPv6 literal', 'http://[fd00::1]/'],
  ['IPv6-mapped IPv4', 'http://[::ffff:169.254.169.254]/'],
  ['decimal', 'http://2852039166/'],
  ['hex, short form', 'http://0x7f.1/'],
  ['octal', 'http://0177.0.0.1/'],
  ['bare integer zero', 'http://0/'],
  ['percent-encoded digits', 'http://%31%36%39.254.169.254/'],
  ['ideographic full stop', 'http://169.254.169.254。/'],
  ['fullwidth digits', 'http://１６９.254.169.254/'],
  ['circled digits', 'http://①⑧②.0.0.1/'],
  ['credentials in front of the host', 'http://user:pw@169.254.169.254/'],
  ['uppercase scheme', 'HTTP://169.254.169.254/'],
];

/** Hostnames that are NOT address literals and that the floor must still refuse (D2). */
const DENIED_BY_NAME = [
  ['this app itself', 'http://localhost:3000/'],
  ['localhost, uppercased', 'http://LOCALHOST/'],
  ['localhost with credentials', 'http://user:pw@localhost:8080/'],
  ['the compose database', 'http://db:5432/'],
  ['GCE/GKE metadata by name', 'http://metadata.google.internal/computeMetadata/v1/'],
  ['a subdomain of a denied host', 'http://sub.metadata.google.internal/'],
];

/** Ordinary targets, which must be allowed by the floor or the fence is useless. */
const ORDINARY = [
  'https://example.com/',
  'https://example.com/checkout?step=2',
  'http://staging.example.com:8443/login',
  'https://xn--80ak6aa92e.com/', // punycode — a hostname, not an address
  'https://localhost.example.com/', // suffix that merely CONTAINS a denied name
  'https://notlocalhost/',
  'https://db.example.com/',
];

// --- N1: the floor blocks every spelling of an address (AC #1) ----------------

for (const [label, url] of ADDRESS_SPELLINGS) {
  test(`floor refuses an IP literal — ${label}`, () => {
    const result = checkStartUrl(url, FLOOR);
    assert.notEqual(result, null, `${url} reached the browser`);
    assert.equal(
      result?.reason,
      REASONS.ip,
      'the reason must say it was an address, so the operator can tell it from a denylist hit'
    );
  });
}

test('isAddressLiteral canonicalizes rather than pattern-matching (D1)', () => {
  // The four the story calls out, asserted on the helper directly so a
  // regression names the helper and not eighteen route tests.
  assert.equal(isAddressLiteral('http://169.254.169.254'), true);
  assert.equal(isAddressLiteral('http://[::ffff:169.254.169.254]'), true);
  assert.equal(isAddressLiteral('http://2852039166/'), true);
  assert.equal(isAddressLiteral('http://0x7f.1/'), true);
  // And the negative that a dotted-quad regex would get right by accident but
  // a naive "contains digits and dots" check would not.
  assert.equal(isAddressLiteral('https://1.2.3.example.com/'), false);
  assert.equal(isAddressLiteral('https://192.168.0.1.nip.io/'), false);
});

// --- N2: the floor blocks hosts that are not addresses at all (AC #5, D2) -----

for (const [label, url] of DENIED_BY_NAME) {
  test(`floor refuses a denied hostname — ${label}`, () => {
    const result = checkStartUrl(url, FLOOR);
    assert.notEqual(result, null, `${url} reached the browser`);
    assert.equal(result?.reason, REASONS.host);
  });
}

test('the denylist is what carries localhost — block_ip_addresses does not (D2)', () => {
  // The proof that D2 is a real finding and not a belt-and-braces flourish:
  // with the denylist emptied and the IP block still on, localhost is allowed.
  // That is browser-use's actual behaviour, and it is why the two settings are
  // two settings. If this assertion ever flips, the denylist has become
  // redundant and the default should be revisited.
  const ipOnly = { blockPrivate: true, deniedHosts: [], allowedDomains: [] };
  assert.equal(checkStartUrl('http://localhost:3000/', ipOnly), null);
  assert.equal(checkStartUrl('http://db:5432/', ipOnly), null);
  // …and 127.0.0.1, which IS a literal, is still refused by the same config.
  assert.equal(checkStartUrl('http://127.0.0.1:3000/', ipOnly)?.reason, REASONS.ip);
});

test('a denied host is matched on the hostname, not as a substring', () => {
  for (const url of ORDINARY) {
    assert.equal(checkStartUrl(url, FLOOR), null, `${url} should be an ordinary target`);
  }
});

// --- N3: schemes the browser would otherwise wave through (D4) ---------------

for (const url of [
  'file:///etc/passwd',
  'data:text/html,<script>fetch("http://169.254.169.254")</script>',
  'blob:https://example.com/1234',
  'chrome://settings/',
  'javascript:fetch("http://169.254.169.254")',
  'about:blank',
]) {
  test(`floor refuses a non-http(s) scheme — ${url.slice(0, 32)}`, () => {
    const result = checkStartUrl(url, FLOOR);
    assert.notEqual(result, null, 'browser-use allows data: and blob: unconditionally (D4)');
    assert.equal(result?.reason, REASONS.scheme);
  });
}

test('an unparseable start_url is refused, not passed through', () => {
  for (const url of ['', '   ', 'not a url', 'http://', '://example.com']) {
    const result = checkStartUrl(url, FLOOR);
    assert.notEqual(result, null, `${JSON.stringify(url)} must not reach the browser`);
    assert.ok(
      result?.reason === REASONS.malformed || result?.reason === REASONS.scheme,
      'a URL we cannot parse is a URL we cannot fence'
    );
  }
});

// --- N4: the project allowlist (AC #3) ---------------------------------------

test('an allowlist confines navigation to itself', () => {
  const policy = {
    blockPrivate: true,
    deniedHosts: DEFAULT_DENIED_HOSTS,
    allowedDomains: ['*.staging.example.com'],
  };
  assert.equal(checkStartUrl('https://app.staging.example.com/', policy), null);
  // Glob vocabulary is browser-use's: *.x matches the apex too (D7).
  assert.equal(checkStartUrl('https://staging.example.com/', policy), null);
  assert.equal(
    checkStartUrl('https://example.com/', policy)?.reason,
    REASONS.allowlist,
    'a host outside the allowlist is refused even though nothing is wrong with it'
  );
  assert.equal(checkStartUrl('https://evil.test/', policy)?.reason, REASONS.allowlist);
});

test('an empty allowlist means "no allowlist", not "nothing is allowed"', () => {
  // The progressive-disclosure rule (CLAUDE.md): a project that never set one
  // behaves exactly like an instance with no projects at all.
  assert.equal(checkStartUrl('https://example.com/', FLOOR), null);
  assert.equal(checkStartUrl('https://example.com/', { ...FLOOR, allowedDomains: [] }), null);
});

test('the floor is checked BEFORE the allowlist, so an allowlist cannot re-open it (D3)', () => {
  // The subtle one the story names: a project allowlist must not silently
  // re-open IP literals. Asserted with the literal spelled INTO the allowlist,
  // which is the only way an operator could plausibly do this by accident.
  const policy = {
    blockPrivate: true,
    deniedHosts: DEFAULT_DENIED_HOSTS,
    allowedDomains: ['169.254.169.254', 'localhost', 'db', '*'],
  };
  assert.equal(checkStartUrl('http://169.254.169.254/', policy)?.reason, REASONS.ip);
  assert.equal(checkStartUrl('http://localhost:3000/', policy)?.reason, REASONS.host);
  assert.equal(checkStartUrl('http://db:5432/', policy)?.reason, REASONS.host);
});

// --- N5: validateAllowlist is the write-time half of AC #5 (D8) ---------------

test('an allowlist that would defeat the floor is refused at write time (D8)', () => {
  // Why this exists at all: when allowed_domains is set, SecurityWatchdog
  // returns from the allowlist branch and never reads prohibited_domains. So
  // the in-browser denylist is NOT a backstop for a bad allowlist — this is.
  for (const bad of ['localhost', 'db', 'metadata.google.internal', 'LOCALHOST']) {
    const result = validateAllowlist([bad], FLOOR);
    assert.notEqual(result, null, `${bad} in an allowlist would re-open the floor`);
    assert.match(String(result?.error), /localhost|db|metadata|not allowed|instance/i);
  }
  for (const bad of ['169.254.169.254', '127.0.0.1', '2852039166', '[::1]', '10.0.0.0/8']) {
    assert.notEqual(validateAllowlist([bad], FLOOR), null, `${bad} is an address, not a domain`);
  }
});

test('a wildcard-everything allowlist is refused — it is a fence spelled as an opening', () => {
  for (const bad of ['*', '*.*', 'http://*', '*.com']) {
    assert.notEqual(validateAllowlist([bad], FLOOR), null, `${bad} allows the whole internet`);
  }
});

test('ordinary allowlist entries are accepted', () => {
  assert.equal(validateAllowlist([], FLOOR), null);
  assert.equal(validateAllowlist(['example.com'], FLOOR), null);
  assert.equal(validateAllowlist(['*.staging.example.com', 'example.com'], FLOOR), null);
});

test('validateAllowlist follows the floor it is given, so the escape hatch reaches it', () => {
  // A self-hoster whose whole use case IS localhost turns the floor off; the
  // allowlist validator must not keep enforcing a floor that no longer exists,
  // or the escape hatch only half-opens.
  assert.equal(validateAllowlist(['localhost'], OFF), null);
  assert.equal(validateAllowlist(['127.0.0.1'], OFF), null);
});

// --- N6: the unset path is byte-for-byte today (AC #4, D6) --------------------

test('with the floor off, every address above is allowed again (AC #4)', () => {
  for (const [label, url] of [...ADDRESS_SPELLINGS, ...DENIED_BY_NAME]) {
    assert.equal(checkStartUrl(url, OFF), null, `${label}: ${url} is the self-hoster's own box`);
  }
});

test('the escape hatch does not also unlock non-http schemes (D4)', () => {
  // Turning the floor off is "I am testing my own machine", not "parse anything
  // the caller sends". file:// on the app container is the host's filesystem,
  // and no localhost use case needs it.
  assert.equal(checkStartUrl('file:///etc/passwd', OFF)?.reason, REASONS.scheme);
  assert.equal(checkStartUrl('data:text/html,hi', OFF)?.reason, REASONS.scheme);
});

test('with the floor off an allowlist still applies — it is a guard rail, not a fence', () => {
  // US-042 sells the per-project allowlist as "useful as a guard rail long
  // before anyone is malicious", so it is not conditional on the floor.
  const policy = { ...OFF, allowedDomains: ['*.staging.example.com'] };
  assert.equal(checkStartUrl('https://app.staging.example.com/', policy), null);
  assert.equal(checkStartUrl('https://example.com/', policy)?.reason, REASONS.allowlist);
  // …and localhost is reachable, because that is what turning the floor off meant.
  assert.equal(checkStartUrl('http://localhost:3000/', { ...OFF, allowedDomains: ['localhost'] }), null);
});
