// batchSummary is pure — it turns what a module/suite run started, queued and
// refused into one line — so it asserts directly, no DOM. Covers US-027's queue
// bucket and US-028's over-the-cap bucket, together and apart.
import { describe, it, expect } from 'vitest';
import { batchSummary } from './runHelpers.js';

describe('batchSummary', () => {
  it('a single-test group just runs below', () => {
    expect(batchSummary({ total: 1, queued: 0 })).toBe('1 test, running below.');
  });

  it('nothing queued or rejected: the rest run in the background', () => {
    expect(batchSummary({ total: 4, queued: 0 })).toBe(
      '4 tests. Following the first below; the rest run in the background.'
    );
  });

  it('some queued behind the concurrency cap (US-027)', () => {
    expect(batchSummary({ total: 4, queued: 3 })).toBe(
      '4 tests. Following the first below; 3 wait for a free slot.'
    );
  });

  it('some over the per-user cap are not started at all (US-028)', () => {
    expect(batchSummary({ total: 12, queued: 0, rejected: 10 })).toBe(
      '12 tests. Following the first below; 10 over your limit — not started.'
    );
  });

  it('queued and rejected read in the same breath', () => {
    expect(batchSummary({ total: 12, queued: 1, rejected: 9 })).toBe(
      '12 tests. Following the first below; 1 wait for a free slot; 9 over your limit — not started.'
    );
  });

  it('rejected defaults to 0 so pre-US-028 callers are unchanged', () => {
    expect(batchSummary({ total: 4, queued: 2 })).toBe(
      '4 tests. Following the first below; 2 wait for a free slot.'
    );
  });
});
