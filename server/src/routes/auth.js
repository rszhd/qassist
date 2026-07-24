// @ts-check
// Magic-link auth endpoints (US-021): request a login link, verify it, log out,
// and report the current user. The crypto and the single-use consume live in
// src/auth.js; this is only the HTTP surface. Every route 404s unless
// authEnabled() — with auth off these endpoints don't exist.
import express from 'express';
import { db } from '../db.js';
import { sendMail } from '../mail.js';
import { PUBLIC_BASE_URL } from '../config.js';
import {
  authEnabled,
  createLoginToken,
  consumeLoginToken,
  signSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../auth.js';
import { h } from './helpers.js';

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

// A small in-memory throttle on link requests: an unauthenticated endpoint that
// sends mail is a spam and enumeration lever otherwise. Per email+IP, a handful
// per window; the map is swept lazily so it can't grow without bound.
const RATE_MAX = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
/** @type {Map<string, number[]>} */
const hits = new Map();
/** @param {string} key @param {number} now */
function rateLimited(key, now) {
  const recent = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  return recent.length > RATE_MAX;
}

/** Absolute base for the link — the configured public URL, else the request's own origin. */
function baseUrl(req) {
  return PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function authRouter({ checkToken }) {
  const r = express.Router();

  // Everything here is meaningless with auth off; say so once.
  r.use((_req, res, next) => (authEnabled() ? next() : res.status(404).json({ error: 'auth is not enabled' })));

  r.post(
    '/request-link',
    h(async (req, res) => {
      const email = String((req.body || {}).email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'a valid email is required' });
      if (rateLimited(`${email}|${req.ip}`, Date.now())) {
        return res.status(429).json({ error: 'too many requests — try again in a few minutes' });
      }
      const token = await createLoginToken(email);
      const link = `${baseUrl(req)}/api/auth/verify?token=${encodeURIComponent(token)}`;
      await sendMail({
        to: email,
        subject: 'Your QAssist sign-in link',
        text:
          `Click to sign in to QAssist:\n\n${link}\n\n` +
          'This link works once and expires in 15 minutes. ' +
          "If you didn't request it, you can ignore this email.",
      });
      // No account enumeration: the reply is the same whether or not this is a
      // first login (signup == login, so it always is a valid address anyway).
      res.json({ ok: true });
    })
  );

  r.get(
    '/verify',
    h(async (req, res) => {
      const token = String(req.query.token || '');
      const user = token ? await consumeLoginToken(token) : null;
      if (!user) return res.redirect('/?auth=invalid');
      res.cookie(SESSION_COOKIE, signSession(user.userId), {
        httpOnly: true,
        sameSite: 'lax',
        secure: baseUrl(req).startsWith('https') || req.secure,
        maxAge: SESSION_TTL_MS,
        path: '/',
      });
      res.redirect('/');
    })
  );

  r.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  r.get(
    '/me',
    checkToken,
    h(async (req, res) => {
      const { rows } = await db().query('select id, email from users where id = $1', [
        /** @type {any} */ (req).userId,
      ]);
      if (!rows.length) return res.status(401).json({ error: 'unauthorized' });
      res.json({ id: rows[0].id, email: rows[0].email });
    })
  );

  return r;
}
