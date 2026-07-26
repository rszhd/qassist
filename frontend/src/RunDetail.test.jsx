// @vitest-environment jsdom
//
// Mount smoke test (US-034) for the run detail card — the piece History and the
// run page both render. Passing `liveSteps` takes the fetch-on-mount path out,
// so this is a pure render over a canned run row: it proves the card, its
// status badge and the verdict stats come up without throwing.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RunDetail from './RunDetail.jsx';

afterEach(cleanup);

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
    expect(screen.getByText('Goal')).toBeTruthy();
    expect(screen.getAllByText(run.goal)).toHaveLength(1);
    expect(screen.getByText('Pass')).toBeTruthy();
    expect(screen.getByText('PDF report')).toBeTruthy();
  });
});
