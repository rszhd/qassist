// @vitest-environment jsdom
//
// US-044: the browser's evidence as it reads in the run detail. The agent owns
// scrubbing, capping and deduplication (agent/tests/test_diagnostics.py); what
// is asserted here is the reading order and the two states that decide whether
// the block appears at all.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Diagnostics from './Diagnostics.jsx';
import RunDetail from './RunDetail.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const entries = [
  { kind: 'exception', step: 2, text: 'TypeError: receipt is null', count: 1 },
  { kind: 'console', step: 1, level: 'warning', text: 'deprecated API', count: 4 },
  { kind: 'request', step: 2, url: 'https://api.test/order', status: 500, count: 1 },
  { kind: 'console', step: null, level: 'error', text: 'failed to load /main.js', count: 1 },
  { kind: 'request', step: 1, url: 'https://api.test/beacon', status: null, error: 'net::ERR_FAILED', count: 1 },
];

describe('Diagnostics', () => {
  it('groups findings by step, with the ones that predate step 1 first', () => {
    render(<Diagnostics diagnostics={entries} />);
    const headings = screen.getAllByText(/^(Step \d+|Before the first step)$/).map((n) => n.textContent);
    // The page was already broken before the agent touched it — that reads first.
    expect(headings).toEqual(['Before the first step', 'Step 1', 'Step 2']);
  });

  it('names a failed request by status, and a dead one by its reason', () => {
    render(<Diagnostics diagnostics={entries} />);
    expect(screen.getByText('500')).toBeTruthy();
    expect(screen.getByText('https://api.test/order')).toBeTruthy();
    // A transport failure has no status to show, so the reason has to carry it.
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('https://api.test/beacon — net::ERR_FAILED')).toBeTruthy();
  });

  it('distinguishes a console warning from an error', () => {
    render(<Diagnostics diagnostics={entries} />);
    expect(screen.getByText('Warn').className).toMatch(/diag-warn/);
    expect(screen.getByText('Error').className).not.toMatch(/diag-warn/);
  });

  it('shows a repeat count only when it says something', () => {
    render(<Diagnostics diagnostics={entries} />);
    expect(screen.getByText('4×')).toBeTruthy();
    // "1×" on four of five rows would be noise.
    expect(screen.queryByText('1×')).toBeNull();
  });

  it('discloses what the cap refused', () => {
    render(<Diagnostics diagnostics={entries} dropped={143} />);
    expect(screen.getByText(/A further 143 distinct findings/)).toBeTruthy();
  });

  it('says nothing about a cap that refused nothing', () => {
    render(<Diagnostics diagnostics={entries} dropped={0} />);
    expect(screen.queryByText(/A further/)).toBeNull();
  });
});

// --- how it reaches the card ------------------------------------------------

const run = {
  id: 'run-1',
  test_name: 'Checkout smoke',
  status: 'failed',
  success: false,
  steps_count: 2,
  created_at: '2026-07-27T10:00:00Z',
  started_at: '2026-07-27T10:00:00Z',
  finished_at: '2026-07-27T10:00:30Z',
  trigger: 'manual',
  start_url: 'https://shop.test',
  goal: 'Buy one widget.',
  report_status: 'ready',
  has_recording: false,
};

describe('RunDetail diagnostics block', () => {
  it('reads the evidence off the same response as the steps', async () => {
    // One request, one settle: a second endpoint could return evidence that
    // disagrees with the steps it is attributed to.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          steps: [{ step: 1, next_goal: 'open page' }],
          diagnostics: entries,
          diagnostics_dropped: 7,
        }),
      }))
    );
    render(
      <MemoryRouter>
        <RunDetail run={run} token="t" onError={() => {}} />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('Diagnostics')).toBeTruthy());
    expect(screen.getByText('https://api.test/order')).toBeTruthy();
    expect(screen.getByText(/A further 7 distinct findings/)).toBeTruthy();
    expect(/** @type {any} */ (globalThis.fetch).mock.calls.length).toBe(1);
  });

  it('grows no block for a run the browser had nothing to say about', async () => {
    // The normal case. An empty "Diagnostics" heading under every passing run
    // would be a permanent unanswered question.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ steps: [{ step: 1, next_goal: 'open page' }], diagnostics: [] }),
      }))
    );
    // The page layout, because the settled fetch has to be visible somewhere
    // for the absence below to mean anything: the History panel no longer
    // renders the step log, so there the Diagnostics block is the only thing
    // that response draws — and it is what this test says is missing.
    render(
      <MemoryRouter>
        <RunDetail run={run} token="t" onError={() => {}} layout="page" />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('Activity')).toBeTruthy());
    expect(screen.queryByText('Diagnostics')).toBeNull();
  });

  it('takes live evidence over a fetch while the run is still going', () => {
    // Same override as liveSteps: refetching would replace a live list with a
    // stale one, and a run in flight has no report file to read anyway.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(
      <MemoryRouter>
        <RunDetail
          run={{ ...run, status: 'running' }}
          token="t"
          onError={() => {}}
          liveSteps={[]}
          liveDiagnostics={{ diagnostics: entries, dropped: 0 }}
        />
      </MemoryRouter>
    );
    expect(screen.getByText('Diagnostics')).toBeTruthy();
    expect(screen.getByText('https://api.test/order')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows nothing once the artifacts have been pruned', () => {
    render(
      <MemoryRouter>
        <RunDetail
          run={{ ...run, artifacts_deleted_at: '2026-08-10T00:00:00Z' }}
          token="t"
          onError={() => {}}
          liveDiagnostics={{ diagnostics: entries, dropped: 3 }}
        />
      </MemoryRouter>
    );
    expect(screen.queryByText('Diagnostics')).toBeNull();
  });
});
