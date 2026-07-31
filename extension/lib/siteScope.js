// @ts-check
// Pure helpers for turning one typed origin into the host permission
// patterns Chrome actually needs to see a site's cookies (US-063).
//
// A session cookie scoped to a parent domain (Domain=.google.com, set once
// and read on every subdomain) is how most SSO providers hold a session —
// Google's SID/HSID/SAPISID family is exactly this shape. A host permission
// for only the exact host the user typed (https://myaccount.google.com/*)
// does not cover those: chrome.cookies.getAll silently omits any cookie
// outside the extension's granted host permissions, even one that would
// plainly apply to that host by ordinary domain-cookie rules. Found live
// against a real Google account, 2026-07-31 — a capture that read only 3 of
// a real session's 10+ cookies, none of them the ones that matter. See
// US-063's Results.
//
// No public-suffix list is bundled (this repo's no-bundler stance for the
// extension), so `registrableDomain` is a last-two-labels heuristic: correct
// for google.com, x.com, github.com and the large majority of SSO providers,
// wrong for a multi-part public suffix like co.uk or github.io. Documented,
// not silently assumed correct — see extension/README.md.

/**
 * @param {string} hostname
 * @returns {string} the registrable-domain guess (last two labels)
 */
export function registrableDomain(hostname) {
  const parts = String(hostname).split('.').filter(Boolean);
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

/**
 * The host permission patterns to request for one typed origin: the exact
 * host, the bare registrable domain (apex-scoped cookies), and a wildcard
 * over its subdomains (the common case — Domain=.example.com cookies).
 * Deduped, since a bare two-label origin (https://x.com) makes the
 * exact-host and apex patterns identical.
 * @param {string} origin e.g. "https://myaccount.google.com"
 * @returns {string[]}
 */
export function permissionPatterns(origin) {
  const url = new URL(origin);
  const root = registrableDomain(url.hostname);
  return [...new Set([`${url.protocol}//${url.hostname}/*`, `${url.protocol}//${root}/*`, `${url.protocol}//*.${root}/*`])];
}
