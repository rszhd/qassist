// @vitest-environment jsdom
//
// US-046 tier 2 — the History total, which is the surface the story warns
// about. Every other cost display answers for one run; this one is a sum, so
// each way it can be wrong arrives as a plausible number rather than a broken
// one, and the reader has nothing on screen to check it against.
//
// Three properties, and they are the same property three times: the line never
// claims more than the server vouched for. It shows the figure only for the
// runs that were priced, it says out loud when that is not all of them, and it
// falls back to tokens instead of falling silent.
//
// The arithmetic itself is the server's and is pinned there (run-cost.test.js,
// run-cost-postgres.test.js, and the tenant case in auth-isolation.test.js).
// What is asserted here is only what the reader is told about it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import HistoryView from './HistoryView.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** One finished run in the list, enough for the view to render a row. */
const RUN = {
  id: 'run-1',
  status: 'passed',
  success: true,
  goal: 'Buy one widget',
  steps_count: 4,
  created_at: '2026-08-01T10:00:00Z',
  started_at: '2026-08-01T10:00:00Z',
  finished_at: '2026-08-01T10:01:00Z',
  trigger: 'ui',
  start_url: 'https://shop.example.test/',
  report_status: 'ready',
};

/** Serve the three endpoints History opens with, and one `usage` object. */
function stubApi({ total = 3, usage }) {
  vi.stubGlobal('fetch', (input) => {
    const path = (typeof input === 'string' ? input : input.url).split('?')[0];
    const bodies = {
      '/api/projects': { projects: [] },
      '/api/tests': { tests: [] },
      '/api/runs': { runs: [RUN], total, limit: 25, offset: 0, usage },
    };
    return Promise.resolve({ ok: true, status: 200, json: async () => bodies[path] ?? {} });
  });
  return render(
    <MemoryRouter initialEntries={['/history']}>
      <HistoryView token="t" />
    </MemoryRouter>
  );
}

/** The whole strip as one string, so an assertion reads like the line does. */
const strip = () => document.querySelector('.hist-total')?.textContent ?? null;

describe('HistoryView cost total (US-046)', () => {
  it('shows the estimate and the tokens when every run in the set was priced', async () => {
    stubApi({ total: 3, usage: { total_cost: 1.238412, priced_runs: 3, total_tokens: 1284310 } });
    await waitFor(() => expect(strip()).toBeTruthy());

    expect(strip()).toContain('Est. cost');
    expect(strip()).toContain('$1.24');
    expect(strip()).toContain(`${(1284310).toLocaleString()} tokens`);
    // Nothing to disclose: the set is whole, and a caveat here would teach the
    // reader to ignore the one that matters.
    expect(strip()).not.toContain('priced');
  });

  it('says how much of the set the total covers when it cannot cover all of it', async () => {
    // The trap, and the reason this view has a test at all. $1.24 over three
    // runs when only two could be priced is wrong downwards, and wrong
    // downwards is the direction nobody questions.
    stubApi({ total: 3, usage: { total_cost: 1.238412, priced_runs: 2, total_tokens: 1284310 } });
    await waitFor(() => expect(strip()).toBeTruthy());

    expect(strip()).toContain('$1.24');
    expect(strip()).toContain('2 of 3 runs priced');
  });

  it('falls back to tokens, and never to $0.00, when nothing could be priced', async () => {
    // An instance with CALCULATE_COST=0, or one that never reached the pricing
    // table. Tokens are still a measurement, and the cost is simply absent.
    stubApi({ total: 3, usage: { total_cost: null, priced_runs: 0, total_tokens: 1284310 } });
    await waitFor(() => expect(strip()).toBeTruthy());

    expect(strip()).toContain(`${(1284310).toLocaleString()} tokens`);
    expect(strip()).toContain('no run in this set could be priced');
    expect(strip()).not.toContain('$');
  });

  it('shows no line at all for a set nothing measured', async () => {
    // Every run from before this shipped. A strip of dashes over them would be
    // a permanent question mark on a screen that has nothing to answer it with.
    stubApi({ total: 3, usage: { total_cost: null, priced_runs: 0, total_tokens: null } });
    await waitFor(() => expect(screen.getByText(RUN.goal)).toBeTruthy());
    expect(strip()).toBeNull();
  });

  it('shows no line against a server that does not send the aggregate', async () => {
    // A viewer pointed at an older worker. Rendering "undefined tokens" here is
    // the cheap failure; rendering "$0.00" is the expensive one.
    stubApi({ total: 3, usage: undefined });
    await waitFor(() => expect(screen.getByText(RUN.goal)).toBeTruthy());
    expect(strip()).toBeNull();
  });
});
