// @ts-check
// The rules for resuming a capture whose popup was destroyed mid-flow (US-068).
//
// A Chrome popup closes whenever it loses focus, and two ordinary steps in
// this flow take the focus away: the browser's own permission dialog, which
// kills the popup that called `chrome.permissions.request`, and switching to
// the QAssist tab to copy the setup code. Both dropped the whole flow — the
// popup reopened at the setup screen with the token gone, and because the
// app's modal mints a fresh code on every open, "start again" meant a new
// code too. It made the first capture fail for every user, every time.
//
// So the in-flight capture is written to `chrome.storage.session` on arrival
// at each screen and read back when the popup reopens. That storage is
// memory-only: never written to disk, dropped when the browser closes, and
// unreachable from content scripts. What it holds is the setup token, the
// instance URL and the origin. The captured session itself still goes nowhere
// near any storage — nothing read out of the site is written here.

/**
 * How long a saved flow stays resumable. The server gives a capture token
 * 15 minutes (`CAPTURE_TOKEN_TTL_MS` in server/src/sessionCapture.js), so a
 * pending entry that outlived that would only carry the user through the
 * confirmation screens to a 401 at the end.
 */
export const PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * Which screen each in-flight screen comes back as. Membership is the whole
 * definition of "worth saving": a screen that is not a key here is one whose
 * flow has ended (setup, success, error) or has nothing to resume.
 */
const RESUME_TO = {
  origin: 'origin',
  explain: 'explain',
  account: 'account',
  // A capture that was in flight when the popup died resumes at the
  // confirmation, never at itself. Re-entering `capturing` would re-post
  // without the account confirmation this flow demands every single time.
  capturing: 'account',
  needTab: 'account',
};

/** The screens that cannot be resumed without knowing which site was named. */
const NEEDS_ORIGIN = new Set(['explain', 'account']);

/**
 * @param {{ token: string, instanceUrl: string, origin: string, screen: string }} state
 * @param {number} now epoch ms
 */
export function makePending(state, now) {
  return {
    token: state.token,
    instanceUrl: state.instanceUrl,
    origin: state.origin || '',
    screen: state.screen,
    savedAt: now,
  };
}

/**
 * The screen a stored entry should reopen at, or null if it should be dropped
 * — expired, malformed, or a flow that had already finished.
 *
 * The caller uses this for both directions: what it declines to resume is
 * exactly what is not worth storing, so the two can't drift apart.
 *
 * @param {any} pending
 * @param {number} now epoch ms
 * @returns {string | null}
 */
export function resumeScreen(pending, now) {
  if (!pending || typeof pending !== 'object') return null;
  if (!isFilled(pending.token) || !isFilled(pending.instanceUrl)) return null;

  // Not `age > TTL`: NaN and a savedAt from the future (a clock that moved
  // backwards mid-flow) both fail this and drop the entry, where a plain
  // upper-bound check would keep a future one forever.
  const age = now - pending.savedAt;
  if (!(age >= 0 && age < PENDING_TTL_MS)) return null;

  const target = RESUME_TO[pending.screen];
  if (!target) return null;
  if (NEEDS_ORIGIN.has(target) && !isFilled(pending.origin)) return null;
  return target;
}

/** @param {any} v */
function isFilled(v) {
  return typeof v === 'string' && v.length > 0;
}
