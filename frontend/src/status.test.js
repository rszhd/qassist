// First frontend test layer (Vitest). status.js is pure — a status→token map
// and two formatters — so it needs no DOM: these assert the mapping and the
// duration/timestamp edge cases directly. A rendered-component smoke test is
// deliberately not here yet; it needs jsdom + a fetch/router harness and is
// tracked in backlog US-034.
import { describe, it, expect } from 'vitest';
import { statusColor, formatWhen, formatDuration } from './status.js';

describe('statusColor', () => {
  it('maps a known status to its fill token', () => {
    expect(statusColor('passed')).toBe('var(--fill-passed)');
    expect(statusColor('failed')).toBe('var(--fill-failed)');
    expect(statusColor('running')).toBe('var(--fill-running)');
  });

  it('falls back to idle for an unknown status', () => {
    expect(statusColor('nonsense')).toBe('var(--fill-idle)');
    expect(statusColor(undefined)).toBe('var(--fill-idle)');
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
