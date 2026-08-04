// @vitest-environment jsdom
//
// The refusal a schedule can be saved into is the server's, and it arrives
// while the dialog is open — a test whose secrets have no stored value cannot
// be scheduled (US-064). What is asserted here is where that message lands:
// inside the dialog, next to the button that caused it, with the form still
// filled in. Rendered on the page it sits behind the overlay.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import SchedulesView from './SchedulesView.jsx';

/** Stands in for History, so a navigation is observable as rendered text. */
function WhereAmI() {
  const { pathname, search } = useLocation();
  return <p>landed:{pathname}{search}</p>;
}

// A row's strip navigates to History (US-069), so the view now needs a router
// around it the way RunDetail does.
const mount = () =>
  render(
    <MemoryRouter initialEntries={['/schedules']}>
      <Routes>
        <Route path="/schedules" element={<SchedulesView token="t" />} />
        <Route path="/history" element={<WhereAmI />} />
      </Routes>
    </MemoryRouter>
  );

const REFUSAL =
  '"Checkout" has no stored value for the secret variable PASSWORD — a scheduled run has nobody to ask for it, so set it on the test first';

function stubApi(schedules = []) {
  vi.stubGlobal('fetch', (input, init) => {
    const path = (typeof input === 'string' ? input : input.url).split('?')[0];
    if (path === '/api/schedules' && init?.method === 'POST') {
      return Promise.resolve({
        ok: false,
        status: 400,
        json: async () => ({ error: REFUSAL }),
      });
    }
    const bodies = {
      '/api/schedules': { schedules },
      '/api/tests': { tests: [{ id: 't1', name: 'Checkout' }] },
      '/api/modules': { modules: [] },
      '/api/suites': { suites: [] },
      '/api/projects': { projects: [] },
    };
    return Promise.resolve({ ok: true, status: 200, json: async () => bodies[path] });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SchedulesView', () => {
  it('keeps a refused create in the dialog, with the form still filled in', async () => {
    stubApi();
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'New schedule' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(await screen.findByLabelText('Test'), { target: { value: 't1' } });
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'daily' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(REFUSAL);
    expect(dialog.contains(alert)).toBe(true);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByLabelText('Repeat').value).toBe('daily');
  });

  // US-069. The strip is drawn from runs, and these schedules have none — the
  // whole point is that the row still has to say something, because a strip
  // that is blank because nothing ran looks exactly like one that is blank
  // because nothing was due.
  it('marks a schedule that is claiming slots and starting nothing', async () => {
    stubApi([
      {
        id: 's1',
        target_type: 'test',
        target_name: 'Nightly checkout',
        target_tests: 1,
        kind: 'daily',
        hour: 2,
        minute: 0,
        tz: 'Europe/Berlin',
        enabled: true,
        next_run_at: '2026-08-05T00:00:00Z',
        last_run_at: '2026-07-28T00:00:04Z',
        firing_into_nothing: true,
      },
      {
        id: 's2',
        target_type: 'test',
        target_name: 'Hourly smoke',
        target_tests: 1,
        kind: 'hourly',
        interval_hours: 1,
        minute: 0,
        tz: 'Europe/Berlin',
        enabled: true,
        next_run_at: '2026-08-04T13:00:00Z',
        last_run_at: '2026-08-04T12:00:03Z',
        firing_into_nothing: false,
      },
    ]);
    mount();

    const broken = (await screen.findByText('Nightly checkout')).closest('li');
    // The tag alone, not a tag plus a restatement in the subtitle: the row
    // already carries a name, a type, a recurrence, two times and three
    // actions, and one warning said twice was part of what crowded it.
    expect(broken.textContent).toContain('not running');

    const healthy = screen.getByText('Hourly smoke').closest('li');
    expect(healthy.textContent).not.toContain('not running');
  });

  it('draws one bar per firing, and sends a click to History for that schedule', async () => {
    stubApi([
      {
        id: 's4',
        target_type: 'suite',
        target_name: 'Pre-release smoke',
        target_tests: 8,
        kind: 'daily',
        hour: 2,
        minute: 0,
        tz: 'Europe/Berlin',
        enabled: true,
        next_run_at: '2026-08-05T00:00:00Z',
        last_run_at: '2026-08-04T00:00:04Z',
        firing_into_nothing: false,
        recent: [
          { scheduled_for: '2026-08-04T00:00:00Z', status: 'failed', runs: 8, failed: 1 },
          { scheduled_for: '2026-08-03T00:00:00Z', status: 'passed', runs: 8, failed: 0 },
        ],
      },
    ]);
    mount();

    const row = (await screen.findByText('Pre-release smoke')).closest('li');
    const strip = row.querySelectorAll('.tl-bar');
    // Sixteen runs over two nights are two bars: a suite must not out-weigh a
    // one-test schedule in a strip of the same width.
    expect(strip).toHaveLength(2);
    expect(strip[1].getAttribute('title')).toContain('1 of 8 failed');
    expect(row.textContent).toContain('1/2 slots passed');

    fireEvent.click(strip[1]);
    // The bar for a night that failed opens History narrowed to this schedule
    // — not to its test, which two schedules could share.
    expect(await screen.findByText('landed:/history?schedule_id=s4')).toBeTruthy();
  });

  it('draws no strip for a schedule with nothing attributed to it', async () => {
    // A schedule that has never fired, and one whose runs all predate the
    // migration, land here identically — and an empty frame would read as
    // "ran, and produced no verdicts".
    stubApi([
      {
        id: 's5',
        target_type: 'test',
        target_name: 'Brand new',
        target_tests: 1,
        kind: 'daily',
        hour: 2,
        minute: 0,
        tz: 'Europe/Berlin',
        enabled: true,
        next_run_at: '2026-08-05T00:00:00Z',
        last_run_at: null,
        firing_into_nothing: false,
        recent: [],
      },
    ]);
    mount();

    const row = (await screen.findByText('Brand new')).closest('li');
    expect(row.querySelector('.timeline')).toBe(null);
  });

  it('does not guess when the row already says why nothing runs', async () => {
    // An empty target is already tagged "no tests", which names the cause the
    // other tag can only point at. Two warnings on one row is one too many.
    stubApi([
      {
        id: 's3',
        target_type: 'project',
        target_name: 'Shop',
        target_tests: 0,
        kind: 'daily',
        hour: 2,
        minute: 0,
        tz: 'Europe/Berlin',
        enabled: true,
        next_run_at: '2026-08-05T00:00:00Z',
        last_run_at: null,
        firing_into_nothing: true,
      },
    ]);
    mount();

    const row = (await screen.findByText('Shop')).closest('li');
    expect(row.textContent).toContain('no tests');
    expect(row.textContent).not.toContain('not running');
  });
});
