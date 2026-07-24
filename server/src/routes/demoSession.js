// @ts-check
// Demo-sandbox session endpoint (US-036). The one unauthenticated surface on an
// AUTH_MODE=demo deployment: the SPA hits it on mount, and it either recognises
// the visitor's existing session cookie or mints a fresh seeded tenant and drops
// the same HTTP-only cookie US-021 issues. From every other handler's point of
// view the visitor is then just a logged-in user who happens to expire.
//
// Mounted only when demoMode() (server.js); off, this path 404s. The per-IP rate
// limit and the total-tenant cap (US-036 step 5) attach here.
import express from 'express';
import { db } from '../db.js';
import {
  PUBLIC_BASE_URL,
  DEMO_MAX_TENANTS,
  DEMO_IP_MAX,
  DEMO_IP_WINDOW_MS,
} from '../config.js';
import {
  demoMode,
  userFromRequest,
  signSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../auth.js';
import { provisionTenant, liveTenantCount } from '../demoTenant.js';
import { h } from './helpers.js';

// Per-IP throttle on *mints* only (US-036 step 5). A returning visitor with a
// valid cookie never reaches this — the limiter guards fresh provisioning, so
// one caller can't drain the total cap. Fixed window, in-memory like the run
// relay; a restart resets it. A hit is recorded only after a mint succeeds, so
// a request rejected by the total cap doesn't burn the IP's quota.
/** @type {Map<string, { count: number, resetAt: number }>} */
const mints = new Map();

/** @param {string} ip @param {number} now @returns {boolean} true if the IP is over quota */
function ipOverQuota(ip, now) {
  const entry = mints.get(ip);
  if (!entry || now >= entry.resetAt) return false;
  return entry.count >= DEMO_IP_MAX;
}

/** @param {string} ip @param {number} now */
function recordMint(ip, now) {
  let entry = mints.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + DEMO_IP_WINDOW_MS };
    mints.set(ip, entry);
  }
  entry.count++;
}

// Bounds the map so a stream of distinct source IPs can't grow it without
// limit; each entry also self-expires on next hit, so this only reclaims idle
// keys. Unref'd — never keeps the process alive.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of mints) if (now >= entry.resetAt) mints.delete(ip);
}, DEMO_IP_WINDOW_MS).unref();

/** @param {import('express').Request} req @param {string} userId */
function setSessionCookie(req, res, userId) {
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.cookie(SESSION_COOKIE, signSession(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: base.startsWith('https') || req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

export function demoSessionRouter() {
  const r = express.Router();

  r.use((_req, res, next) => (demoMode() ? next() : res.status(404).json({ error: 'not found' })));

  // Provision-or-return: a reload that still carries a valid cookie keeps its
  // tenant (and its edits) instead of minting a second one. Only a visitor with
  // no/invalid session gets a fresh seeded tenant and a new cookie.
  r.post(
    '/session',
    h(async (req, res) => {
      const existing = await userFromRequest(req);
      if (existing) {
        const { rows } = await db().query(
          'select demo_expires_at from users where id = $1',
          [existing]
        );
        if (rows.length && rows[0].demo_expires_at) {
          return res.json({ expiresAt: rows[0].demo_expires_at });
        }
      }

      // Guards apply to minting only, past the returning-cookie shortcut above.
      const now = Date.now();
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      if (ipOverQuota(ip, now)) {
        res.setHeader('Retry-After', String(Math.ceil(DEMO_IP_WINDOW_MS / 1000)));
        return res.status(429).json({ error: 'too many sandboxes from this address, try later' });
      }
      if ((await liveTenantCount({ now })) >= DEMO_MAX_TENANTS) {
        res.setHeader('Retry-After', '60');
        return res.status(503).json({ error: 'demo is at capacity, try again shortly' });
      }

      const { userId, expiresAt } = await provisionTenant({ now });
      recordMint(ip, now);
      setSessionCookie(req, res, userId);
      res.status(201).json({ expiresAt });
    })
  );

  return r;
}
