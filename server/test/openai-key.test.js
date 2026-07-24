// @ts-check
// US-005 (BYOK) — assertion-first spec, pure half: the encryption primitive, the
// key-shape gate, and the request>stored>server precedence. All decidable
// without a DB or a spawn, so this file always runs; the DB/at-rest/leak
// properties live in openai-key-postgres.test.js (bytea needs a real server).
//
// This is a secret-at-rest surface — same class as the per-user API keys and
// the session cookie (backlog/correctness-critical.md). Reviewer's job
// (assertion-first): tighten these BEFORE the implementation. Properties:
//
//   E1 — encryptSecret/decryptSecret round-trip a realistic key exactly.
//   E2 — the same key encrypts to different ciphertext each time (fresh IV);
//        the plaintext is never a substring of the ciphertext.
//   E3 — GCM integrity: a tampered ciphertext makes decrypt THROW, never
//        returns a wrong plaintext (an attacker can't flip bits undetected).
//   S1 — validOpenaiKeyShape accepts an `sk-` key and rejects empty / non-`sk-`
//        garbage, so a malformed key is refused before it is ever stored.
//   P1 — resolveRunKey precedence is exactly request > stored > server(null).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/** @type {typeof import('../src/crypto.js')} */
let crypto;
/** @type {typeof import('../src/openaiKey.js')} */
let openaiKey;

// A realistic-looking key: `sk-` prefix, project style, long random tail. Not a
// real credential.
const SAMPLE_KEY = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';

before(async () => {
  process.env.KEY_ENCRYPTION_SECRET = 'test-key-encryption-secret-0123456789';
  crypto = await import('../src/crypto.js');
  openaiKey = await import('../src/openaiKey.js');
});

// --- E1: round-trip ---

test('encryptSecret/decryptSecret round-trip a realistic key exactly', () => {
  const buf = crypto.encryptSecret(SAMPLE_KEY);
  assert.ok(Buffer.isBuffer(buf), 'ciphertext is bytes for the bytea column');
  assert.equal(crypto.decryptSecret(buf), SAMPLE_KEY);
});

// --- E2: fresh IV, no plaintext in the ciphertext ---

test('encrypting the same key twice yields different ciphertext (fresh IV)', () => {
  const a = crypto.encryptSecret(SAMPLE_KEY);
  const b = crypto.encryptSecret(SAMPLE_KEY);
  assert.ok(!a.equals(b), 'a static IV would make these identical and leak equality');
  assert.equal(crypto.decryptSecret(a), SAMPLE_KEY);
  assert.equal(crypto.decryptSecret(b), SAMPLE_KEY);
});

test('the plaintext key never appears inside its own ciphertext', () => {
  const buf = crypto.encryptSecret(SAMPLE_KEY);
  assert.equal(buf.includes(Buffer.from(SAMPLE_KEY, 'utf8')), false, 'as raw bytes');
  assert.equal(buf.toString('latin1').includes(SAMPLE_KEY), false, 'as a string slice');
});

// --- E3: GCM integrity ---

test('a tampered ciphertext byte makes decrypt throw, never returns wrong plaintext', () => {
  const buf = crypto.encryptSecret(SAMPLE_KEY);
  // Flip a byte in the ciphertext body (past the IV+tag header).
  const tampered = Buffer.from(buf);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => crypto.decryptSecret(tampered), 'GCM auth tag must reject the edit');
});

test('decrypt under a different secret throws rather than returning garbage', async () => {
  const buf = crypto.encryptSecret(SAMPLE_KEY);
  // Truncation is corruption too — a short buffer must not silently decode.
  assert.throws(() => crypto.decryptSecret(buf.subarray(0, 8)));
});

// --- S1: key-shape gate ---

test('validOpenaiKeyShape accepts sk- keys and rejects malformed input', () => {
  assert.equal(crypto.validOpenaiKeyShape(SAMPLE_KEY), true);
  assert.equal(crypto.validOpenaiKeyShape('sk-' + 'x'.repeat(40)), true);
  for (const bad of ['', '   ', 'nope', 'pk-live-123', 'sk-', 'sk-short']) {
    assert.equal(crypto.validOpenaiKeyShape(bad), false, `rejects ${JSON.stringify(bad)}`);
  }
  // A key with surrounding whitespace is malformed as given — the caller trims
  // before validating, so the validator sees the trimmed form.
  assert.equal(crypto.validOpenaiKeyShape(/** @type {any} */ (undefined)), false);
});

// --- P1: resolution precedence ---

test('resolveRunKey precedence is request > stored > null', () => {
  assert.equal(
    openaiKey.resolveRunKey({ requestKey: 'sk-req', storedKey: 'sk-stored' }),
    'sk-req',
    'a per-request key wins over the stored one'
  );
  assert.equal(
    openaiKey.resolveRunKey({ requestKey: null, storedKey: 'sk-stored' }),
    'sk-stored',
    'the stored key is used when no request key is given'
  );
  assert.equal(
    openaiKey.resolveRunKey({ requestKey: '', storedKey: 'sk-stored' }),
    'sk-stored',
    'an empty request key is not a key'
  );
  assert.equal(
    openaiKey.resolveRunKey({ requestKey: null, storedKey: null }),
    null,
    'no user key at all falls through to the server key (handled by startRun)'
  );
});
