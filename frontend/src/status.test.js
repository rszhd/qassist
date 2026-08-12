// status.js is pure — a status→token map and two formatters — so it needs no
// DOM: these assert the mapping and the duration/timestamp edge cases directly.
// This file stays in the default node env; the rendered-component smoke tests
// (App.test.jsx, RunDetail.test.jsx) opt into jsdom per-file (US-034).
import { describe, it, expect } from 'vitest';
import {
  statusColor, statusLabel, formatWhen, formatDuration, formatCost, formatTokens,
} from './status.js';

describe('statusColor', () => {
  it('maps a known status to its fill token', () => {
    expect(statusColor('passed')).toBe('var(--fill-passed)');
    expect(statusColor('failed')).toBe('var(--fill-failed)');
    expect(statusColor('running')).toBe('var(--fill-running)');
  });

  // US-047: without an entry of its own a stopped run silently took the idle
  // fallback, which is the colour of a run that never happened.
  it('gives a stopped run its own fill rather than the idle fallback', () => {
    expect(statusColor('cancelled')).toBe('var(--fill-cancelled)');
    expect(statusColor('cancelled')).not.toBe(statusColor('completed'));
  });

  it('falls back to idle for an unknown status', () => {
    expect(statusColor('nonsense')).toBe('var(--fill-idle)');
    expect(statusColor(undefined)).toBe('var(--fill-idle)');
  });
});

describe('statusLabel', () => {
  it('shows the stored `cancelled` as the word the UI stops runs with', () => {
    expect(statusLabel('cancelled')).toBe('stopped');
  });

  it('leaves every other status as the API writes it', () => {
    expect(statusLabel('passed')).toBe('passed');
    expect(statusLabel('queued')).toBe('queued');
  });
});

describe('formatWhen', () => {
  it('returns the dash placeholder for a missing timestamp', () => {
    expect(formatWhen(null)).toBe('—');
    expect(formatWhen(undefined)).toBe('—');
  });

  it('renders something for a real timestamp', () => {
    expect(formatWhen('2026-07-24T10:30:00Z')).not.toBe('—');
  });
});

describe('formatDuration', () => {
  const start = '2026-07-24T10:00:00Z';

  it('dashes when either end is missing', () => {
    expect(formatDuration(null, start)).toBe('—');
    expect(formatDuration(start, null)).toBe('—');
  });

  it('shows bare seconds under a minute', () => {
    expect(formatDuration(start, '2026-07-24T10:00:45Z')).toBe('45s');
  });

  it('shows minutes and seconds at or over a minute', () => {
    expect(formatDuration(start, '2026-07-24T10:01:30Z')).toBe('1m 30s');
    expect(formatDuration(start, '2026-07-24T10:01:00Z')).toBe('1m 0s');
  });

  it('dashes a negative span rather than printing it', () => {
    expect(formatDuration('2026-07-24T10:00:45Z', start)).toBe('—');
  });
});

// US-046. Every assertion here is really the same one: a cost this side of the
// app cannot vouch for must not leave looking like a small charge.
describe('formatCost', () => {
  it('renders a known cost, keeping the cents a fixed 2dp would round away', () => {
    expect(formatCost(0.041, true, 12431)).toBe('$0.041');
    expect(formatCost(1.5, true, 900000)).toBe('$1.50');
  });

  it('says so rather than rounding an amount below a tenth of a cent to zero', () => {
    expect(formatCost(0.0004, true, 120)).toBe('< $0.001');
  });

  it('renders a measured zero as free, because a known zero is a fact', () => {
    expect(formatCost(0, true, 12431)).toBe('$0.00');
  });

  it('renders an unpriced run as unknown — never as zero', () => {
    expect(formatCost(null, false, 12431)).toBe('Unknown');
    // The number is not the discriminator: a 0.0 that arrived with the flag
    // false is one of the three cases the flag exists to catch.
    expect(formatCost(0, false, 12431)).toBe('Unknown');
    expect(formatCost(0.041, false, 12431)).toBe('Unknown');
  });

  it('dashes a run nothing measured, which is not the same as unpriced', () => {
    expect(formatCost(null, false, null)).toBe('—');
    expect(formatCost(undefined, undefined, undefined)).toBe('—');
  });
});

describe('formatTokens', () => {
  it('dashes an uncounted run and separates a counted one', () => {
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(12431)).toBe((12431).toLocaleString());
  });
});
