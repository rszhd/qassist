// @ts-check
// Account settings (US-005): the caller's stored BYOK OpenAI key. Set/replace,
// clear, and read its set-state — the value is never returned by any read. The
// crypto and persistence live in ../crypto.js and ../openaiKey.js; this is the
// tenant-scoped HTTP surface (currentUserId), a multi-user feature like keys.js.
import express from 'express';
import { currentUserId } from '../db.js';
import { authEnabled } from '../auth.js';
import { validOpenaiKeyShape, keyEncryptionEnabled } from '../crypto.js';
import { setUserOpenaiKey, clearUserOpenaiKey, getUserOpenaiKeyStatus } from '../openaiKey.js';
import { requireDb, h } from './helpers.js';

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function accountRouter({ checkToken }) {
  const r = express.Router();
  r.use((_req, res, next) => (authEnabled() ? next() : res.status(404).json({ error: 'auth is not enabled' })));
  r.use(checkToken, requireDb);

  r.get(
    '/openai-key',
    h(async (_req, res) => {
      res.json(await getUserOpenaiKeyStatus(currentUserId()));
    })
  );

  r.put(
    '/openai-key',
    h(async (req, res) => {
      if (!keyEncryptionEnabled()) {
        return res.status(503).json({ error: 'KEY_ENCRYPTION_SECRET is not set — stored keys are disabled' });
      }
      const key = String((req.body || {}).key || '').trim();
      // Shape-checked before any write: a malformed key never reaches the DB.
      if (!validOpenaiKeyShape(key)) {
        return res.status(400).json({ error: 'that does not look like an OpenAI key (expected sk-…)' });
      }
      res.json(await setUserOpenaiKey(currentUserId(), key));
    })
  );

  r.delete(
    '/openai-key',
    h(async (_req, res) => {
      await clearUserOpenaiKey(currentUserId());
      res.status(204).end();
    })
  );

  return r;
}
