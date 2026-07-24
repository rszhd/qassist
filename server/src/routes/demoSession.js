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
import { PUBLIC_BASE_URL } from '../config.js';
import {
  demoMode,
  userFromRequest,
  signSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../auth.js';
import { provisionTenant } from '../demoTenant.js';
import { h } from './helpers.js';

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
      const { userId, expiresAt } = await provisionTenant();
      setSessionCookie(req, res, userId);
      res.status(201).json({ expiresAt });
    })
  );

  return r;
}
