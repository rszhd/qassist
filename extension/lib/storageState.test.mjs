// Plain `node --test` over storageState.js's pure mapping functions — no
// chrome.* mock needed because the module under test never calls chrome.*
// itself (see its own header). The chrome.* glue that calls these functions
// (permission prompts, chrome.identity, chrome.scripting) has no test harness
// in this repo and is hand-verified instead — see extension/README.md and the
// story's Results section.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toPlaywrightCookie,
  toPlaywrightCookies,
  toPlaywrightOrigin,
  buildStorageState,
} from './storageState.js';

test('a session cookie (no expirationDate) maps to expires: -1', () => {
  const mapped = toPlaywrightCookie({
    name: 'sid',
    value: 'abc',
    domain: 'example.com',
    path: '/',
    session: true,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  });
  assert.equal(mapped.expires, -1);
  assert.equal(mapped.sameSite, 'Lax');
});

test('a persistent cookie keeps its expirationDate', () => {
  const mapped = toPlaywrightCookie({
    name: 'remember',
    value: 'xyz',
    domain: '.example.com',
    path: '/',
    session: false,
    expirationDate: 1893456000,
    httpOnly: false,
    secure: true,
    sameSite: 'no_restriction',
  });
  assert.equal(mapped.expires, 1893456000);
  assert.equal(mapped.sameSite, 'None');
});

test('sameSite capitalization covers every chrome.cookies.SameSiteStatus value', () => {
  assert.equal(toPlaywrightCookie({ sameSite: 'strict' }).sameSite, 'Strict');
  assert.equal(toPlaywrightCookie({ sameSite: 'lax' }).sameSite, 'Lax');
  assert.equal(toPlaywrightCookie({ sameSite: 'no_restriction' }).sameSite, 'None');
  // Chrome's own "unspecified" has no Playwright equivalent — Lax is
  // Playwright's own default, so that is the closest safe mapping.
  assert.equal(toPlaywrightCookie({ sameSite: 'unspecified' }).sameSite, 'Lax');
});

test('a malformed cookie does not throw and fills in safe defaults', () => {
  assert.doesNotThrow(() => toPlaywrightCookie(null));
  assert.doesNotThrow(() => toPlaywrightCookie(undefined));
  assert.doesNotThrow(() => toPlaywrightCookie({}));
  const mapped = toPlaywrightCookie({ name: 42, value: null });
  assert.equal(mapped.name, '');
  assert.equal(mapped.value, '');
  assert.equal(mapped.path, '/');
  assert.equal(mapped.expires, -1);
});

test('toPlaywrightCookies maps an array and tolerates non-arrays', () => {
  assert.deepEqual(toPlaywrightCookies(null), []);
  assert.deepEqual(toPlaywrightCookies(undefined), []);
  const mapped = toPlaywrightCookies([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].name, 'a');
});

test('an origin with no localStorage entries maps to null, not an empty slot', () => {
  assert.equal(toPlaywrightOrigin('https://example.com', []), null);
  assert.equal(toPlaywrightOrigin('https://example.com', undefined), null);
  assert.equal(toPlaywrightOrigin('https://example.com', 'not-an-array'), null);
});

test('an origin with localStorage entries maps to Playwright\'s origins[] shape', () => {
  const mapped = toPlaywrightOrigin('https://example.com', [
    ['token', 'abc123'],
    ['theme', 'dark'],
  ]);
  assert.deepEqual(mapped, {
    origin: 'https://example.com',
    localStorage: [
      { name: 'token', value: 'abc123' },
      { name: 'theme', value: 'dark' },
    ],
  });
});

test('a malformed localStorage entry does not throw and is dropped', () => {
  assert.doesNotThrow(() => toPlaywrightOrigin('https://example.com', [null, ['ok', 'v'], 'bad', [1, 'v']]));
  const mapped = toPlaywrightOrigin('https://example.com', [null, ['ok', 'v'], 'bad', [1, 'v']]);
  assert.deepEqual(mapped.localStorage, [{ name: 'ok', value: 'v' }]);
});

test('buildStorageState assembles cookies and a single origin entry', () => {
  const state = buildStorageState({
    cookies: [{ name: 'sid', value: 'abc', session: true }],
    origin: 'https://example.com',
    localStorageEntries: [['token', 'xyz']],
  });
  assert.equal(state.cookies.length, 1);
  assert.equal(state.origins.length, 1);
  assert.equal(state.origins[0].origin, 'https://example.com');
});

test('buildStorageState with cookies only omits origins entirely', () => {
  const state = buildStorageState({
    cookies: [{ name: 'sid', value: 'abc', session: true }],
    origin: 'https://example.com',
    localStorageEntries: [],
  });
  assert.equal(state.cookies.length, 1);
  assert.deepEqual(state.origins, []);
});
