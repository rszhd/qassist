import test from 'node:test';
import assert from 'node:assert/strict';
import { makePending, resumeScreen, PENDING_TTL_MS } from './pendingCapture.js';

const NOW = 1_770_000_000_000;
const flow = (screen, origin = 'https://x.com') => ({
  token: 'tok',
  instanceUrl: 'https://app.qassist.run',
  origin,
  screen,
});

test('makePending stamps the flow so its age can be judged later', () => {
  assert.deepEqual(makePending(flow('explain'), NOW), {
    token: 'tok',
    instanceUrl: 'https://app.qassist.run',
    origin: 'https://x.com',
    screen: 'explain',
    savedAt: NOW,
  });
});

test('the mid-flow screens resume where they were left', () => {
  for (const screen of ['origin', 'explain', 'account']) {
    assert.equal(resumeScreen(makePending(flow(screen), NOW), NOW), screen);
  }
});

// The permission dialog closing the popup is the whole reason this exists,
// and it lands on `explain`.
test('explain resumes with the token intact', () => {
  const pending = makePending(flow('explain'), NOW);
  assert.equal(resumeScreen(pending, NOW + 60_000), 'explain');
  assert.equal(pending.token, 'tok');
});

// A capture that was in flight when the popup died must not re-post on its
// own: the account confirmation is required before every capture, so both of
// these come back to it rather than to themselves.
test('an interrupted capture resumes at the confirmation, not at the capture', () => {
  assert.equal(resumeScreen(makePending(flow('capturing'), NOW), NOW), 'account');
  assert.equal(resumeScreen(makePending(flow('needTab'), NOW), NOW), 'account');
});

test('a finished or unstarted flow is not resumable', () => {
  for (const screen of ['setup', 'success', 'error', 'settings', 'nonsense']) {
    assert.equal(resumeScreen(makePending(flow(screen), NOW), NOW), null);
  }
});

test('a pending entry dies with the token it carries', () => {
  const pending = makePending(flow('account'), NOW);
  assert.equal(resumeScreen(pending, NOW + PENDING_TTL_MS - 1), 'account');
  assert.equal(resumeScreen(pending, NOW + PENDING_TTL_MS), null);
  assert.equal(resumeScreen(pending, NOW + PENDING_TTL_MS * 10), null);
});

// A clock that moved backwards mid-flow would otherwise leave an entry that
// never ages out.
test('a savedAt in the future is dropped, not trusted', () => {
  assert.equal(resumeScreen(makePending(flow('account'), NOW + 1), NOW), null);
});

test('a malformed entry is dropped rather than half-resumed', () => {
  assert.equal(resumeScreen(null, NOW), null);
  assert.equal(resumeScreen('pending', NOW), null);
  assert.equal(resumeScreen({ ...makePending(flow('account'), NOW), token: '' }, NOW), null);
  assert.equal(resumeScreen({ ...makePending(flow('account'), NOW), instanceUrl: '' }, NOW), null);
  assert.equal(resumeScreen({ ...makePending(flow('account'), NOW), savedAt: undefined }, NOW), null);
  assert.equal(resumeScreen({ ...makePending(flow('account'), NOW), savedAt: 'soon' }, NOW), null);
});

// Naming the site is what `origin` collects, so it is the one screen that can
// resume without one — and the two after it cannot.
test('the screens that need a site refuse to resume without one', () => {
  assert.equal(resumeScreen(makePending(flow('origin', ''), NOW), NOW), 'origin');
  assert.equal(resumeScreen(makePending(flow('explain', ''), NOW), NOW), null);
  assert.equal(resumeScreen(makePending(flow('account', ''), NOW), NOW), null);
  assert.equal(resumeScreen(makePending(flow('capturing', ''), NOW), NOW), null);
});
