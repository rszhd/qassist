// status.js is pure — a status→token map and two formatters — so it needs no
// DOM: these assert the mapping and the duration/timestamp edge cases directly.
// This file stays in the default node env; the rendered-component smoke tests
// (App.test.jsx, RunDetail.test.jsx) opt into jsdom per-file (US-034).
import { describe, it, expect } from 'vitest';
import { statusColor, statusLabel, formatWhen, formatDuration } from './status.js';

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
