// @ts-check
// Per-user API keys (US-021): create, list and revoke the bearer tokens CI
// (US-008) sends. The crypto lives in src/auth.js; the consume path
// (userFromCredentials) matches on sha256 of the bearer and skips revoked rows.
// This is only the HTTP surface, tenant-scoped by currentUserId().
//
// Keys are a multi-user feature: with auth off, per-user keys are never
// consulted (single-token/open mode uses WORKER_API_TOKEN), so the whole router
// 404s — the Settings UI shows key management only in that mode.
import express from 'express';
import { db, currentUserId, isUuid } from '../db.js';
import { authEnabled, mintApiKey } from '../auth.js';
import { requireDb, h } from './helpers.js';

// The plaintext token is deliberately absent here — it exists only in the
// create response. Never widen this to include token_hash.
const COLS = 'id, label, created_at, last_used_at, revoked_at';

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function keysRouter({ checkToken }) {
  const r = express.Router();
  r.use((_req, res, next) => (authEnabled() ? next() : res.status(404).json({ error: 'auth is not enabled' })));
  r.use(checkToken, requireDb);

  r.get(
    '/',
    h(async (_req, res) => {
      const { rows } = await db().query(
        `select ${COLS} from api_keys where user_id = $1 order by created_at desc`,
        [currentUserId()]
      );
      res.json({ keys: rows });
    })
  );

  r.post(
    '/',
    h(async (req, res) => {
      const label = String((req.body || {}).label || '').trim().slice(0, 120) || null;
      const { token, hash } = mintApiKey();
      const { rows } = await db().query(
        `insert into api_keys (user_id, token_hash, label) values ($1, $2, $3) returning ${COLS}`,
        [currentUserId(), hash, label]
      );
      // The one and only time the plaintext leaves the server.
      res.status(201).json({ ...rows[0], token });
    })
  );

  r.post(
    '/:id/revoke',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rowCount } = await db().query(
        `update api_keys set revoked_at = now()
          where id = $1 and user_id = $2 and revoked_at is null`,
        [req.params.id, currentUserId()]
      );
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      res.status(204).end();
    })
  );

  return r;
}
