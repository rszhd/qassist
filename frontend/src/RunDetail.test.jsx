// @vitest-environment jsdom
//
// Mount smoke test (US-034) for the run detail card — the piece History and the
// run page both render. Passing `liveSteps` takes the fetch-on-mount path out,
// so this is a pure render over a canned run row: it proves the card, its
// status badge and the verdict stats come up without throwing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RunDetail from './RunDetail.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const run = {
  id: 'run-1',
  test_name: 'Checkout smoke',
  status: 'passed',
  success: true,
  steps_count: 4,
  started_at: '2026-07-24T10:00:00Z',
  finished_at: '2026-07-24T10:01:30Z',
  created_at: '2026-07-24T10:00:00Z',
  trigger: 'manual',
  start_url: 'https://example.com',
  goal: 'Buy one widget and reach the confirmation page.',
  report_status: 'ready',
  has_recording: false,
};

describe('RunDetail', () => {
  it('renders a finished run from its row without fetching', () => {
    render(
      <MemoryRouter>
        <RunDetail run={run} token="t" onError={() => {}} liveSteps={[]} />
      </MemoryRouter>
    );

    expect(screen.getByText('Checkout smoke')).toBeTruthy();
    expect(screen.getByText('passed')).toBeTruthy();
    expect(screen.getByText('Pass')).toBeTruthy();
    expect(screen.getByText(run.goal)).toBeTruthy();
  });

  // The page arrangement drops the run's own title and status because RunPage's
  // header already carries both — the duplication is the thing being prevented,
  // so it's what the test pins.
  it('renders the page layout without repeating the title RunPage already shows', () => {
    render(
      <MemoryRouter>
        <RunDetail run={run} token="t" onError={() => {}} liveSteps={[]} layout="page" />
      </MemoryRouter>
    );

    expect(screen.queryByText('Checkout smoke')).toBeNull();
    expect(screen.queryByText('passed')).toBeNull();

    // Same blocks as the panel, rearranged — not a second copy of them.
    expect(screen.getByText('Instructions')).toBeTruthy();
    expect(screen.getAllByText(run.goal)).toHaveLength(1);
    expect(screen.getByText('Pass')).toBeTruthy();
    expect(screen.getByText('PDF report')).toBeTruthy();
  });
});

// US-047. This card is History's and the run page's only lever on a run in
// flight, and it renders the row it was handed — so the two things worth
// pinning are that the button appears exactly while the run is unfinished, and
// that a stopped run reads as stopped with no verdict attached to it.
describe('RunDetail stopping a run (US-047)', () => {
  const live = { ...run, status: 'running', success: null, finished_at: null, report_status: 'none' };

  function renderDetail(props) {
    return render(
      <MemoryRouter>
        <RunDetail run={run} token="t" onError={() => {}} liveSteps={[]} {...props} />
      </MemoryRouter>
    );
  }

  it('offers Stop while the run is unfinished and posts it', async () => {
    const calls = [];
    vi.stubGlobal('fetch', (input, init = {}) => {
      calls.push({ url: input, method: init.method || 'GET' });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    const onStopped = vi.fn();
    renderDetail({ run: live, onStopped });

    fireEvent.click(screen.getByText('Stop run'));

    await waitFor(() => expect(onStopped).toHaveBeenCalled());
    expect(calls).toEqual([{ url: '/api/runs/run-1/stop', method: 'POST' }]);
    // Still disabled: the row is the caller's, so nothing flips until it
    // comes back cancelled.
    expect(screen.getByText('Stopping…').closest('button').disabled).toBe(true);
  });

  it('shows no Stop button for a run that has already ended', () => {
    renderDetail({});
    expect(screen.queryByText('Stop run')).toBeNull();
  });

  it('reads a cancelled run as stopped, with no verdict', () => {
    renderDetail({ run: { ...run, status: 'cancelled', success: null } });

    // The column value is `cancelled`; the word a person is shown is the one
    // the button used.
    const badge = screen.getByText('stopped');
    expect(badge.className).toContain('badge-cancelled');
    expect(screen.queryByText('Pass')).toBeNull();
    expect(screen.queryByText('Fail')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('Stop run')).toBeNull();
  });
});
