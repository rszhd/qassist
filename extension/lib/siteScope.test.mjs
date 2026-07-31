import test from 'node:test';
import assert from 'node:assert/strict';
import { registrableDomain, permissionPatterns } from './siteScope.js';

test('registrableDomain strips subdomains down to the last two labels', () => {
  assert.equal(registrableDomain('myaccount.google.com'), 'google.com');
  assert.equal(registrableDomain('accounts.google.com'), 'google.com');
  assert.equal(registrableDomain('a.b.c.example.com'), 'example.com');
});

test('registrableDomain leaves an already-bare domain alone', () => {
  assert.equal(registrableDomain('x.com'), 'x.com');
  assert.equal(registrableDomain('localhost'), 'localhost');
});

// Known, documented limitation: no public-suffix list, so a multi-part
// suffix reads as one label too few. Pinned so a "fix" doesn't silently
// change this without updating the doc that explains it.
test('registrableDomain is wrong for multi-part public suffixes, by design', () => {
  assert.equal(registrableDomain('www.example.co.uk'), 'co.uk');
});

test('permissionPatterns covers the exact host, the apex, and its subdomains', () => {
  const patterns = permissionPatterns('https://myaccount.google.com');
  assert.deepEqual(patterns, [
    'https://myaccount.google.com/*',
    'https://google.com/*',
    'https://*.google.com/*',
  ]);
});

test('permissionPatterns dedupes when the typed origin is already the apex', () => {
  const patterns = permissionPatterns('https://x.com');
  assert.deepEqual(patterns, ['https://x.com/*', 'https://*.x.com/*']);
});
