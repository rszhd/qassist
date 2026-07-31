// @ts-check
// The capture token a browser extension uses to post a session (US-063).
//
// Deliberately not `api_keys`. An api_keys row is full-privilege for the user
// who holds it — every endpoint that user can reach. This token must be able
// to do exactly one thing, once: fill the one `browser_sessions` row it was
// minted for. So it is its own table, consumed the same atomic single-use way
// `auth.js`'s login tokens are (`update … where used_at is null and
// expires_at > now()`), and checked by exactly one route
// (`routes/capture.js`) that never consults `userFromRequest`.
//
// Correctness-critical (backlog/correctness-critical.md), as an extension of
// the "Saved browser sessions" row. Spec: session-capture-token.test.js.
import crypto from 'node:crypto';
import { db, sha256 } from './db.js';

/** How long a minted token stays claimable. Matches auth.js's login-link TTL:
 * the extension flow is a few clicks, not a background job. */
export const CAPTURE_TOKEN_TTL_MS = 15 * 60 * 1000;

/** A recognizable prefix, so a leaked token is greppable — same reason
 * auth.js's API_KEY_PREFIX exists. */
export const CAPTURE_TOKEN_PREFIX = 'qsc_';

/**
 * Mint a fresh capture token for a session and store its hash.
 * @param {string} sessionId
 * @param {string|null} userId who minted it, for the audit column only —
 *   never consulted by the consume path
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ token: string, expiresAt: Date }>}
 */
export async function mintCaptureToken(sessionId, userId, { now = Date.now() } = {}) {
  const token = CAPTURE_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + CAPTURE_TOKEN_TTL_MS);
  await db().query(
    `insert into session_capture_tokens (session_id, token_hash, created_by, expires_at)
     values ($1, $2, $3, $4)`,
    [sessionId, sha256(token), userId, expiresAt]
  );
  return { token, expiresAt };
}

/**
 * Claim a capture token: single-use and time-boxed, exactly like
 * `consumeLoginToken`. Returns the session (and its project, for scoping the
 * caller has no other way to prove) or null when the token is unknown,
 * already used, or expired.
 * @param {string} token
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ sessionId: string, projectId: string } | null>}
 */
export async function consumeCaptureToken(token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token) return null;
  // Two queries rather than one `update … from`, mirroring `consumeLoginToken`
  // (auth.js): pg-mem's SQL support is a documented subset (docs/testing.md),
  // and this shape is the one already proven against it.
  const { rows } = await db().query(
    `update session_capture_tokens set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > $2
      returning session_id`,
    [sha256(token), new Date(now)]
  );
  if (!rows.length) return null;
  const sessionId = rows[0].session_id;
  const { rows: sessions } = await db().query(
    'select project_id from browser_sessions where id = $1',
    [sessionId]
  );
  // The session was deleted in the window between mint and consume — the
  // cascade would already have taken the token with it, so this is only
  // reachable by a race with the delete itself. Fail closed either way.
  if (!sessions.length) return null;
  return { sessionId, projectId: sessions[0].project_id };
}
