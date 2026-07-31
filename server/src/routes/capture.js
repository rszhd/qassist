// @ts-check
// POST /api/capture (US-063) — the one endpoint a browser extension talks to.
//
// Deliberately mounted with NO checkToken. The extension holds no QAssist
// login of its own — the capture token in its Authorization header IS its
// entire credential, consumed once by sessionCapture.js's atomic claim, and
// it authenticates nothing beyond "write this one session, this one time".
// Compare routes/keys.js's api_keys, which are full-privilege for the user
// who holds them — a capture token must never be able to do what those do,
// which is why it is checked here and nowhere `checkToken` is mounted.
//
// The blob never appears in the response: on success this answers 204 with
// an empty body, on failure a plain error string. Nothing here ever echoes
// `req.body` back.
import express from 'express';
import { consumeCaptureToken } from '../sessionCapture.js';
import { captureFromExtension, normalizeStorageState } from '../browserSession.js';
import { requireDb, h } from './helpers.js';

const BEARER = /^Bearer (.+)$/;

export function captureRouter() {
  const r = express.Router();
  r.use(requireDb);

  r.post(
    '/',
    h(async (req, res) => {
      const m = BEARER.exec(req.headers.authorization || '');
      if (!m) return res.status(401).json({ error: 'unauthorized' });

      // Shape-check before spending the single use: a malformed post (a bug in
      // the extension, a bad paste) should be retryable with the same token,
      // not force the user back through minting a fresh setup code.
      const body = /** @type {any} */ (req.body || {});
      const normalized = normalizeStorageState(body.storage_state);
      if ('error' in normalized) return res.status(400).json({ error: normalized.error });

      const claim = await consumeCaptureToken(m[1]);
      if (!claim) return res.status(401).json({ error: 'that capture link has expired or was already used' });

      const result = await captureFromExtension(claim.sessionId, body.storage_state);
      if ('error' in result) return res.status(400).json({ error: result.error });
      res.status(204).end();
    })
  );

  return r;
}
