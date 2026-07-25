// @ts-check
// What this process needs before it may serve (US-039). A missing requirement
// is a refusal to boot, naming what is absent — never a half-enabled app that
// 401s every request or degrades into a mode nobody chose.
//
// Pure on purpose: config.js is read at import time, so a matrix of
// missing-var cases cannot be exercised in one process. Same seam as
// billingReady() in billing.js. server.js does the reading and the exiting.

/**
 * The env var names this process is missing, in a fixed order so the message is
 * stable. Empty = serve.
 *
 * DATABASE_URL and KEY_ENCRYPTION_SECRET are unconditional since US-039: a run
 * is funded by its caller's key, that key lives encrypted on a `users` row, and
 * without either half there is nowhere to put one and nothing to run.
 *
 * @param {{
 *   hasDb: boolean,
 *   hasKeyEncryption: boolean,
 *   authRequested: boolean,
 *   mailReady: boolean,
 *   hasSessionSecret: boolean,
 *   demoRequested: boolean,
 * }} state
 * @returns {string[]}
 */
export function missingBootRequirements({
  hasDb,
  hasKeyEncryption,
  authRequested,
  mailReady,
  hasSessionSecret,
  demoRequested,
}) {
  const missing = [];
  if (!hasDb) missing.push('DATABASE_URL');
  if (!hasKeyEncryption) missing.push('KEY_ENCRYPTION_SECRET');
  // Prose rather than a var name for the one requirement that is a pair.
  if (authRequested && !mailReady) missing.push('a mail sender (RESEND_API_KEY + MAIL_FROM)');
  // Both features sign cookies with it; the operator should see one line to fix.
  if ((authRequested || demoRequested) && !hasSessionSecret) missing.push('SESSION_SECRET');
  return missing;
}
