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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RunView from './RunView.jsx';

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
function stubEnv() {
  const calls = [];
  vi.stubGlobal('fetch', (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    let body = {};
    if (url.includes('/run')) body = { runId: 'r1', status: 'queued' };
    else if (url.startsWith('/api/tests')) body = { tests: [PLAIN, WITH_VARS] };
    else if (url.startsWith('/api/projects')) body = { projects: [] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  vi.stubGlobal('WebSocket', class { close() {} });
  return calls;
}

function renderRunView() {
  return render(
    <RunView
      token="t"
      health={{ db: true }}
      keyStatus={{ set: true, updated_at: null }}
      visible
      needsToken={false}
      onOpenSettings={() => {}}
      onRunState={() => {}}
    />
  );
}

const runCalls = (calls) => calls.filter((c) => c.url.includes('/run'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  vi.stubGlobal('WebSocket', class { close() {} });
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

// The secret flag has real editor logic worth pinning: marking a variable
// secret drops its stored default (so no plaintext secret is persisted), and
// saving a test that references a secret in the Start URL is blocked client-
// side — the server only rejects that at run time (US-035 secret path).
const writeCalls = (calls) =>
  calls.filter((c) => c.url.startsWith('/api/tests') && (c.method === 'POST' || c.method === 'PUT'));

async function openEnvTestEditor() {
  const editButtons = await screen.findAllByLabelText('Edit');
  // [Plain test, Env test] in list order — Env test is the one with variables.
  fireEvent.click(editButtons[1]);
  return screen.findByText('Edit test');
}

describe('VariablesEditor secret flag (US-035)', () => {
  it('drops the stored default when a variable is marked secret', async () => {
    stubEnv();
    renderRunView();
    await openEnvTestEditor();

    expect(screen.getByDisplayValue('https://staging.example.com')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Secret'));

    // Default field is gone (nothing to persist) and the per-run note replaces it.
    expect(screen.queryByDisplayValue('https://staging.example.com')).toBeNull();
    expect(screen.getByText('value set per run / CI')).toBeTruthy();
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
