// @vitest-environment jsdom
//
// The refusal a schedule can be saved into is the server's, and it arrives
// while the dialog is open — a test whose secrets have no stored value cannot
// be scheduled (US-064). What is asserted here is where that message lands:
// inside the dialog, next to the button that caused it, with the form still
// filled in. Rendered on the page it sits behind the overlay.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SchedulesView from './SchedulesView.jsx';

const REFUSAL =
  '"Checkout" has no stored value for the secret variable PASSWORD — a scheduled run has nobody to ask for it, so set it on the test first';

function stubApi() {
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
      '/api/schedules': { schedules: [] },
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
    render(<SchedulesView token="t" />);

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
});
