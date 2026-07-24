// @ts-check
// Magic-link auth (US-021). Two credentials, both correctness-critical
// (backlog/correctness-critical.md): a stateless signed session cookie, and a
// single-use login link. No passwords, no sessions table — revocation is
// SESSION_SECRET rotation, which the story accepts for v1.
//
// The two crypto surfaces are pinned assertion-first in auth.test.js; the
// single-use / expiry consume and cross-tenant isolation in
// auth-isolation.test.js (pg-mem) and auth-postgres.test.js (the concurrent
// redemption race, which pg-mem can't prove).
import crypto from 'node:crypto';
import { db, sha256 } from './db.js';
import { mailEnabled } from './mail.js';
import { AUTH_ENABLED, AUTH_MODE, SESSION_SECRET } from './config.js';

/** Name of the cookie carrying the signed session. */
export const SESSION_COOKIE = 'qassist_session';
/** How long a session cookie stays valid. Revocation is secret rotation. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Login links are short-lived — the ≤15 min acceptance criterion. */
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Multi-user mode is on only when it was asked for *and* everything it needs is
 * present: the control plane, a mail sender, and a signing secret. Missing any
 * one leaves the app in its single-token / open behavior (server.js refuses to
 * boot in that state when AUTH_ENABLED is set, so this is belt-and-braces).
 */
export function authEnabled() {
  return AUTH_ENABLED && !!SESSION_SECRET && mailEnabled() && !!db();
}

/**
 * Demo-sandbox mode (US-036): the deployment provisions an anonymous cookie
 * tenant per visitor and replays every run. On only when explicitly asked for
 * *and* the control plane + signing secret the cookie tenants need are present.
 * Unlike authEnabled() it needs no mail sender — there is no login link, signup
 * is silent. Mutually exclusive with authEnabled() in practice: a deployment is
 * the magic-link app or the demo, not both.
 */
export function demoMode() {
  return AUTH_MODE === 'demo' && !!SESSION_SECRET && !!db();
}

// --- session cookie: `${userId}.${expiresAtMs}.${hmac}` ---

/** @param {string} payload */
function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

/**
 * @param {string} userId
 * @param {{ now?: number }} [opts]
 */
export function signSession(userId, { now = Date.now() } = {}) {
  const payload = `${userId}.${now + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * The userId a cookie authenticates, or null if it is malformed, forged,
 * tampered with, or expired. Never throws — bad input is just "not logged in".
 * @param {string} value
 * @param {{ now?: number }} [opts]
 * @returns {string | null}
 */
export function verifySession(value, { now = Date.now() } = {}) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [userId, expStr, mac] = parts;
  if (!userId || !expStr || !mac) return null;
  const expected = sign(`${userId}.${expStr}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || now >= exp) return null;
  return userId;
}

// --- login link ---

/** @param {string} token */
export function hashLoginToken(token) {
  return sha256(token);
}

/**
 * A fresh link secret (goes in the email URL) and the hash we store for it.
 * @param {{ now?: number }} [opts]
 * @returns {{ token: string, hash: string, expiresAt: Date }}
 */
export function mintLoginToken({ now = Date.now() } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashLoginToken(token), expiresAt: new Date(now + LOGIN_TOKEN_TTL_MS) };
}

/**
 * Mint a login link for an address and store its hash. Returns the secret to
 * put in the email; the plaintext is never persisted.
 * @param {string} email
 * @param {{ now?: number }} [opts]
 */
export async function createLoginToken(email, { now = Date.now() } = {}) {
  const { token, hash, expiresAt } = mintLoginToken({ now });
  await db().query(
    'insert into login_tokens (token_hash, email, expires_at) values ($1, $2, $3)',
    [hash, email.toLowerCase(), expiresAt]
  );
  return token;
}

/**
 * Redeem a login link: mark it used and return the user it logs in, creating
 * that user on first sight (signup == login). Single-use and expiry are the
 * `update … where used_at is null and expires_at > now` claim — atomic per row,
 * so concurrent redemptions of the same secret leave exactly one winner.
 * Returns null when the secret is unknown, already used, or expired.
 * @param {string} token
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ userId: string, email: string } | null>}
 */
export async function consumeLoginToken(token, { now = Date.now() } = {}) {
  const { rows } = await db().query(
    `update login_tokens set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > $2
      returning email`,
    [hashLoginToken(token), new Date(now)]
  );
  if (!rows.length) return null;
  const email = rows[0].email;
  await db().query('insert into users (email) values ($1) on conflict (email) do nothing', [email]);
  const u = await db().query('select id from users where email = $1', [email]);
  return { userId: u.rows[0].id, email };
}

// --- per-user API keys ---

/**
 * A recognizable prefix so a leaked key is greppable and secret-scanners can
 * spot it. The stored hash covers the whole string, prefix included.
 */
export const API_KEY_PREFIX = 'qak_';

/**
 * A fresh API key and the hash to store. The plaintext is returned once at
 * creation and never persisted; `userFromCredentials` matches on sha256 of the
 * bearer, so the hash must be sha256 of the whole token.
 * @returns {{ token: string, hash: string }}
 */
export function mintApiKey() {
  const token = API_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

/**
 * Resolve the authenticated user from raw credentials in multi-user mode: a
 * valid session cookie, else a live per-user API key (the bearer CI uses, and
 * the WS upgrade passes as ?token=). Returns null when neither authenticates.
 * The legacy shared WORKER_API_TOKEN is deliberately not consulted here (and
 * db.js does not seed it as a key when AUTH_ENABLED), so it stops working once
 * auth is on.
 * @param {{ cookieHeader?: string, bearer?: string }} creds
 * @returns {Promise<string | null>}
 */
export async function userFromCredentials({ cookieHeader, bearer }) {
  const cookie = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (cookie) {
    const uid = verifySession(cookie);
    if (uid) return uid;
  }
  if (bearer) {
    const { rows } = await db().query(
      `update api_keys set last_used_at = now()
        where token_hash = $1 and revoked_at is null
        returning user_id`,
      [sha256(bearer)]
    );
    if (rows.length) return rows[0].user_id;
  }
  return null;
}

/**
 * The HTTP-request form of userFromCredentials.
 * @param {import('express').Request} req
 * @returns {Promise<string | null>}
 */
export function userFromRequest(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return userFromCredentials({ cookieHeader: req.headers.cookie, bearer: m ? m[1] : undefined });
}

/**
 * Minimal cookie-header parser — no dependency for one header we read.
 * @param {string | undefined | null} header
 * @returns {Record<string, string>}
 */
function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
