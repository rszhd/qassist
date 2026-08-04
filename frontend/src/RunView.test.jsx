// @vitest-environment jsdom
//
// US-035 dispatch test. The one behaviour worth pinning in the Run view is the
// progressive-disclosure fork: clicking Run on a test with no variables must
// fire the run on one click (unchanged from before), while a test that
// declares variables must instead open the override dialog and post nothing
// until you submit it. A regression here either breaks the basic one-click
// flow or silently skips the environment prompt, and the build can't see
// either. The rest of RunView (WebSocket, live frames) is stubbed away.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RunView from './RunView.jsx';

// Every socket the view opens, newest last, so a test can push relay events
// into the one belonging to the run it just started.
const sockets = [];
const emit = (evt) => act(() => sockets.at(-1).onmessage({ data: JSON.stringify(evt) }));

const PLAIN = {
  id: 'plain-1',
  name: 'Plain test',
  goal: 'Open the page and read the heading.',
  start_url: 'https://example.com',
  variables: [],
  project_id: null,
  module_id: null,
};

const WITH_VARS = {
  id: 'vars-1',
  name: 'Env test',
  goal: 'Log in at {{base_url}} and reach the dashboard.',
  start_url: '{{base_url}}/login',
  variables: [{ name: 'base_url', value: 'https://staging.example.com', secret: false, optional: false }],
  project_id: null,
  module_id: null,
};

// Records every request so the test can assert whether — and with what body —
// a run was posted. WebSocket is stubbed because a successful run opens one.
function stubEnv(withVars = WITH_VARS) {
  const calls = [];
  vi.stubGlobal('fetch', (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    let body = {};
    if (url.includes('/run')) body = { runId: 'r1', status: 'queued' };
    else if (url.startsWith('/api/tests')) body = { tests: [PLAIN, withVars] };
    else if (url.startsWith('/api/projects')) body = { projects: [] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  vi.stubGlobal('WebSocket', class {
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    close() {}
  });
  return calls;
}

// Inside a router: the view links a started run to its own page, and a bare
// <Link> outside one throws.
function renderRunView() {
  return render(
    <MemoryRouter>
      <RunView
        token="t"
        health={{ db: true }}
        keyStatus={{ set: true, updated_at: null }}
        visible
        needsToken={false}
        onOpenSettings={() => {}}
        onRunState={() => {}}
      />
    </MemoryRouter>
  );
}

const runCalls = (calls) => calls.filter((c) => c.url.includes('/run'));

afterEach(() => {
  cleanup();
  sockets.length = 0;
  // Minimizing the rail is remembered, and the store outlives cleanup() — left
  // set, the next test would render with the rail already collapsed.
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The rail is a column by default and the strip is opt-in, which is the opposite
// of what a `min` written on mount would produce — so this pins both halves.
describe('RunView tests rail', () => {
  it('opens with the view, and minimizing leaves a strip that opens it again', async () => {
    stubEnv();
    renderRunView();

    expect(await screen.findByLabelText('Run "Plain test"')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Minimize tests'));
    expect(screen.queryByLabelText('Run "Plain test"')).toBeNull();

    fireEvent.click(screen.getByTitle('Show tests'));
    expect(await screen.findByLabelText('Run "Plain test"')).toBeTruthy();
  });
});

describe('RunView run dispatch (US-035)', () => {
  it('runs a variable-less test on one click, with no override dialog', async () => {
    const calls = stubEnv();
    renderRunView();

    fireEvent.click(await screen.findByLabelText('Run "Plain test"'));

    await waitFor(() => expect(runCalls(calls)).toHaveLength(1));
    expect(runCalls(calls)[0].url).toContain('/api/tests/plain-1/run');
    expect(runCalls(calls)[0].body.variables).toBeUndefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a prefilled override dialog for a variable\'d test and posts nothing until submit', async () => {
    const calls = stubEnv();
    renderRunView();

    fireEvent.click(await screen.findByLabelText('Run "Env test"'));

    // Dialog is up, prefilled with the default — and crucially no run yet.
    expect(screen.getByText('Run Env test')).toBeTruthy();
    expect(screen.getByDisplayValue('https://staging.example.com')).toBeTruthy();
    expect(runCalls(calls)).toHaveLength(0);

    // Override the value, then submit — the run carries the overridden map.
    fireEvent.change(screen.getByDisplayValue('https://staging.example.com'), {
      target: { value: 'https://prod.example.com' },
    });
    fireEvent.click(screen.getByText('Run test'));

    await waitFor(() => expect(runCalls(calls)).toHaveLength(1));
    expect(runCalls(calls)[0].url).toContain('/api/tests/vars-1/run');
    expect(runCalls(calls)[0].body.variables).toEqual({ base_url: 'https://prod.example.com' });
  });
});

// US-022: a run refused for want of a subscription is not a failed run. It must
// land in its own notice carrying the way out, never the red error banner, and
// leave the view idle rather than stuck in a phantom 'error' run.
function stubRefusedEnv(payload) {
  const calls = [];
  vi.stubGlobal('fetch', (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method || 'GET' });
    if (url.includes('/run')) {
      return Promise.resolve({ ok: false, status: 402, json: async () => payload });
    }
    if (url.startsWith('/api/billing/checkout')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://checkout.stripe.test/s1' }),
      });
    }
    const body = url.startsWith('/api/tests') ? { tests: [PLAIN] } : { projects: [] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  vi.stubGlobal('WebSocket', class {
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    close() {}
  });
  return calls;
}

const REFUSAL = {
  error: 'an active subscription is required to start runs — subscribe in Settings',
  billing_required: true,
  subscription_status: null,
};

describe('RunView billing refusal (US-022)', () => {
  it('shows the subscribe notice, not the error banner, and stays idle', async () => {
    stubRefusedEnv(REFUSAL);
    renderRunView();

    fireEvent.click(await screen.findByLabelText('Run "Plain test"'));

    const notice = await screen.findByText('Subscription needed');
    expect(notice.closest('.banner')).toBeTruthy();
    expect(screen.getByText(REFUSAL.error)).toBeTruthy();
    expect(notice.closest('.error')).toBeNull();
    // Idle again rather than stuck in a run that never started.
    expect(screen.queryByText('Running…')).toBeNull();
    expect(screen.queryByText('Queued…')).toBeNull();
  });

  it('offers Resubscribe when the account used to pay, and posts checkout', async () => {
    const calls = stubRefusedEnv({ ...REFUSAL, subscription_status: 'canceled' });
    // jsdom's location is unforgeable, so the whole object is swapped rather
    // than the method spied — checkout ends in a real navigation to Stripe.
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, protocol: 'http:', host: 'localhost' });
    renderRunView();

    fireEvent.click(await screen.findByLabelText('Run "Plain test"'));

    expect(await screen.findByText('Subscription lapsed')).toBeTruthy();
    fireEvent.click(screen.getByText('Resubscribe'));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/billing/checkout' && c.method === 'POST')).toBe(true)
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/s1'));
  });
});

// The other half of the CTA: Stripe sends the customer back to `/?billing=…`
// on a full page load, and that param is the only signal the app gets.
describe('RunView checkout return (US-022)', () => {
  function stubReturn(outcome) {
    stubEnv();
    const replaceState = vi.fn();
    vi.stubGlobal('location', { search: `?billing=${outcome}`, pathname: '/', protocol: 'http:', host: 'localhost' });
    vi.stubGlobal('history', { replaceState });
    return replaceState;
  }

  it('acknowledges a completed checkout and strips the param', async () => {
    const replaceState = stubReturn('success');
    renderRunView();

    expect(await screen.findByText(/Payment complete/)).toBeTruthy();
    // Stripped, so a reload doesn't say it again.
    expect(replaceState).toHaveBeenCalledWith({}, '', '/');
  });

  it('says nothing about a checkout the customer backed out of', async () => {
    const replaceState = stubReturn('cancelled');
    renderRunView();

    await waitFor(() => expect(replaceState).toHaveBeenCalledWith({}, '', '/'));
    expect(screen.queryByText(/Payment complete/)).toBeNull();
  });
});

// US-047. The frontend twin of the run engine's property V (see
// server/test/stop-run.test.js): browser-use returns history normally out of
// Agent.stop(), so the relayed `done` event of a stopped run still carries the
// agent's self-report — and unlike the row and the HTTP shape, which the server
// rewrites through verdictOf(), that event reaches the view as the agent wrote
// it. A view that believes it paints a green Passed card over a run the user
// aborted, which is the whole thing the status exists to prevent. The stubs
// below emit `success: true` on every stop path deliberately.
async function startPlainRun() {
  const calls = stubEnv();
  renderRunView();
  fireEvent.click(await screen.findByLabelText('Run "Plain test"'));
  await waitFor(() => expect(sockets).toHaveLength(1));
  return calls;
}

const stopCalls = (calls) => calls.filter((c) => c.url.endsWith('/stop') && c.method === 'POST');

describe('RunView stopping a run (US-047)', () => {
  it('stops a running run, and the agent\'s own success is not the verdict', async () => {
    const calls = await startPlainRun();
    emit({ type: 'status', status: 'running' });

    fireEvent.click(screen.getByText('Stop run'));

    await waitFor(() => expect(stopCalls(calls)).toHaveLength(1));
    expect(stopCalls(calls)[0].url).toBe('/api/runs/r1/stop');
    expect(screen.getByText('Stopping…')).toBeTruthy();

    // What the run actually reports on the way out: a stop the agent honoured,
    // its partial evidence, and a self-report claiming success.
    emit({ type: 'stopping' });
    emit({ type: 'done', success: true, steps: 3, duration_seconds: 12, final_result: 'All good' });
    emit({ type: 'end', status: 'cancelled' });

    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(screen.queryByText('Passed')).toBeNull();
    expect(screen.queryByText('Pass')).toBeNull();
    // The evidence survives — it is what the report is built from — but it is
    // filed under a run that answered nothing.
    expect(screen.getByText('All good')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText(/reached no verdict/)).toBeTruthy();
  });

  it('honours a stop started somewhere else, replayed over the relay', async () => {
    await startPlainRun();
    emit({ type: 'status', status: 'running' });

    // No click here: the stop came from another tab or the run page, and this
    // viewer learns of it only through the durable `stopping` broadcast.
    emit({ type: 'stopping' });
    expect(screen.getByText('Stopping…')).toBeTruthy();

    emit({ type: 'done', success: true, steps: 1 });
    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(screen.queryByText('Passed')).toBeNull();
  });

  it('says a queued run was stopped before it ever started', async () => {
    const calls = await startPlainRun();
    // Still queued — no `status: running`, so the server dequeues it and ends
    // it in one step, with no `done` event because nothing ever ran.
    fireEvent.click(screen.getByText('Stop run'));
    await waitFor(() => expect(stopCalls(calls)).toHaveLength(1));
    emit({ type: 'end', status: 'cancelled' });

    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(screen.getByText(/never started/)).toBeTruthy();
    // Nothing to open: a run that never ran has no report and no recording.
    expect(screen.queryByText('PDF report')).toBeNull();
  });

  it('offers no Stop button once the run has ended', async () => {
    await startPlainRun();
    emit({ type: 'status', status: 'running' });
    expect(screen.getByText('Stop run')).toBeTruthy();

    emit({ type: 'done', success: true, steps: 2 });
    emit({ type: 'end', status: 'passed' });

    expect(screen.queryByText('Stop run')).toBeNull();
    expect(screen.getByText('Passed')).toBeTruthy();
  });
});

// The secret flag has real editor logic worth pinning: what a secret's value
// box means, and that saving a test which references a secret in the Start URL
// is blocked client-side — the server only rejects that at run time (US-035
// secret path).
//
// US-064 deliberately changed the first half. Ticking Secret used to CLEAR the
// value, because nothing was allowed to persist one; now the value is stored
// encrypted (which is what lets a schedule type it at 02:00), so the tick masks
// the field instead of emptying it. The behaviour below is the new contract,
// not a loosened assertion: the box being empty on open now means "keep what is
// stored", so what has to be pinned is that the row says which state it is in
// and offers a way to erase.
const writeCalls = (calls) =>
  calls.filter((c) => c.url.startsWith('/api/tests') && (c.method === 'POST' || c.method === 'PUT'));

async function openEnvTestEditor() {
  const editButtons = await screen.findAllByLabelText('Edit');
  // [Plain test, Env test] in list order — Env test is the one with variables.
  fireEvent.click(editButtons[1]);
  return screen.findByText('Edit test');
}

describe('VariablesEditor secret flag (US-035, amended by US-064)', () => {
  it('masks the value when a variable is marked secret, and keeps it', async () => {
    stubEnv();
    renderRunView();
    await openEnvTestEditor();

    const box = screen.getByLabelText('Variable 1 default value');
    expect(box.type).toBe('text');

    fireEvent.click(screen.getByLabelText('Secret'));

    // The value survives the tick — it is what gets encrypted on save — but it
    // is never shown again, so the box that holds it is a password field.
    const masked = screen.getByLabelText('Variable 1 secret value');
    expect(masked.type).toBe('password');
    expect(masked.value).toBe('https://staging.example.com');
    // Nothing is stored for it yet, and the row has to say so: a blank box on
    // the next open would otherwise be indistinguishable from a kept value.
    expect(screen.getByText('not set')).toBeTruthy();
  });

  it('offers a set/not-set state and an explicit clear for a stored secret', async () => {
    stubEnv({
      ...WITH_VARS,
      goal: 'Log in as admin with {{pw}}.',
      start_url: 'https://example.com/login',
      variables: [{ name: 'pw', value: '', secret: true, optional: false, value_set: true }],
    });
    renderRunView();
    await openEnvTestEditor();

    // Empty box + "stored" is the whole point: blank means keep.
    expect(screen.getByLabelText('Variable 1 secret value').value).toBe('');
    expect(screen.getByText('stored')).toBeTruthy();

    fireEvent.click(screen.getByText('Clear'));
    expect(screen.getByText('will be cleared')).toBeTruthy();

    // ...and it is reversible before saving, because the alternative to an
    // explicit clear is a gesture that also means "leave it alone".
    fireEvent.click(screen.getByText('Keep'));
    expect(screen.getByText('stored')).toBeTruthy();
  });

  it('does not send a blank secret box as an override of ""', async () => {
    const calls = stubEnv({
      ...WITH_VARS,
      goal: 'Log in as admin with {{pw}}.',
      start_url: 'https://example.com/login',
      variables: [{ name: 'pw', value: '', secret: true, optional: false, value_set: true }],
    });
    renderRunView();

    fireEvent.click(await screen.findByLabelText('Run "Env test"'));
    fireEvent.click(await screen.findByText('Run test'));

    await waitFor(() => expect(runCalls(calls)).toHaveLength(1));
    // An untouched box means "use the stored value", so the request must not
    // claim the operator supplied an empty one.
    expect(runCalls(calls)[0].body.variables).toEqual({});
  });

  it('blocks saving a test that references a secret in the Start URL', async () => {
    const calls = stubEnv();
    renderRunView();
    await openEnvTestEditor();

    // start_url is already `{{base_url}}/login`; marking base_url secret makes
    // the save illegal.
    fireEvent.click(screen.getByLabelText('Secret'));
    fireEvent.click(screen.getByText('Save changes'));

    await screen.findByText(/secret variable base_url cannot appear in the Start URL/i);
    expect(writeCalls(calls)).toHaveLength(0);
  });
});
