// @ts-check
// Pure mappings from chrome.* shapes to Playwright's storageState (US-063).
//
// Zero chrome.* calls in this file — popup.js is the only thing that calls
// chrome.cookies.getAll / chrome.scripting.executeScript, and it hands the
// raw results here. That split is what lets storageState.test.mjs be a plain
// `node --test`: no fake-chrome harness, because nothing here touches chrome.

const SAME_SITE = {
  no_restriction: 'None',
  lax: 'Lax',
  strict: 'Strict',
  unspecified: 'Lax',
};

/**
 * One `chrome.cookies.Cookie` -> one Playwright storageState cookie.
 *
 * Degrades rather than throws on a malformed entry: a cookie missing an
 * expected field becomes the closest safe default instead of aborting the
 * whole capture over one bad cookie the browser handed back.
 * @param {any} cookie
 */
export function toPlaywrightCookie(cookie) {
  const c = cookie || {};
  return {
    name: typeof c.name === 'string' ? c.name : '',
    value: typeof c.value === 'string' ? c.value : '',
    domain: typeof c.domain === 'string' ? c.domain : '',
    path: typeof c.path === 'string' ? c.path : '/',
    // A session cookie carries no `expirationDate` at all — Playwright's
    // convention for "expires when the browser closes" is -1, not absent.
    expires: c.session || typeof c.expirationDate !== 'number' ? -1 : c.expirationDate,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: SAME_SITE[c.sameSite] || 'Lax',
  };
}

/** @param {any} cookies chrome.cookies.getAll()'s result */
export function toPlaywrightCookies(cookies) {
  return Array.isArray(cookies) ? cookies.map(toPlaywrightCookie) : [];
}

/**
 * One origin's localStorage -> a Playwright `origins[]` entry, or `null` when
 * there is nothing to carry. An origin with no localStorage is not worth a
 * zero-length entry — cookie-only auth is common and should not manufacture
 * an empty origins slot for it.
 * @param {string} origin
 * @param {any} entries `Object.entries(localStorage)` from the page
 */
export function toPlaywrightOrigin(origin, entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const localStorage = entries
    .filter((e) => Array.isArray(e) && typeof e[0] === 'string')
    .map(([name, value]) => ({ name, value: typeof value === 'string' ? value : String(value ?? '') }));
  if (!localStorage.length) return null;
  return { origin, localStorage };
}

/**
 * Assemble the full storageState the extension posts to `/api/capture`.
 * @param {{ cookies: any, origin: string, localStorageEntries: any }} parts
 * @returns {{ cookies: any[], origins: any[] }}
 */
export function buildStorageState({ cookies, origin, localStorageEntries }) {
  const mapped = toPlaywrightOrigin(origin, localStorageEntries);
  return { cookies: toPlaywrightCookies(cookies), origins: mapped ? [mapped] : [] };
}
