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

// What a saved test remembers (US-081). Mutable, so a test can put the notebook
// in doubt without a second stub — restored in its own `finally`.
const LESSON = {
  id: 'a1',
  text: 'Open Billing from the account menu',
  steps: [4],
  run_id: 'run-1',
  learned_at: '2026-08-01T09:00:00.000Z',
  hinted: false,
};
const MEMORY = {
  learned: { successful_approach: [LESSON], avoid_next_time: [], orientation: [] },
  supplied: { successful_approach: [LESSON], avoid_next_time: [], orientation: [] },
  withheld: null,
  learned_at: '2026-08-01T09:00:00.000Z',
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
    // Before the /api/tests branch — a memory URL starts with it too (US-081).
    else if (url.includes('/memory')) body = MEMORY;
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
function renderRunView(health = { db: true }, token = 't') {
  return render(
    <MemoryRouter>
      <RunView
        token={token}
        health={health}
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
    // Nothing to open: a run that never ran has no report.
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

// US-076 moved the current action into the Activity card and retired the
// Watch-recording toggle. The two are pinned together because the branch that
// played the recording in the stage did NOT go with the button — a demo has no
// live frames, so the player is still its stage feed.
describe('RunView activity leads the run (US-076)', () => {
  it('pulses the newest row while the run is live, and stops when it ends', async () => {
    stubEnv();
    const { container } = renderRunView();
    fireEvent.click(await screen.findByLabelText('Run "Plain test"'));
    await waitFor(() => expect(sockets).toHaveLength(1));

    emit({ type: 'status', status: 'running' });
    emit({ type: 'step', step: 1, next_goal: 'Open the page' });
    emit({ type: 'step', step: 2, next_goal: 'Click the login link' });

    // Newest first, so the pulse belongs to the row the log puts at the top —
    // and the row it marks is the one still being worked on, which is why the
    // dot stands in for that row's number rather than sitting beside it.
    const rows = () => [...container.querySelectorAll('.stage-side .log-item')];
    expect(rows()[0].textContent).toContain('Click the login link');
    expect(rows()[0].querySelector('.pulse')).toBeTruthy();
    expect(rows()[0].querySelector('.step-n')).toBeNull();
    expect(rows()[1].querySelector('.pulse')).toBeNull();
    expect(rows()[1].querySelector('.step-n')?.textContent).toBe('1');

    // Nothing is in progress once the run is over, so every row is numbered.
    emit({ type: 'done', success: true, steps: 2 });
    emit({ type: 'end', status: 'passed' });
    expect(container.querySelector('.pulse')).toBeNull();
    expect(rows()[0].querySelector('.step-n')?.textContent).toBe('2');
  });

  it('says what a stop is waiting for, which no step row carries', async () => {
    await startPlainRun();
    emit({ type: 'status', status: 'running' });
    emit({ type: 'step', step: 1, next_goal: 'Open the page' });
    expect(screen.queryByText(/Finishing the recording/)).toBeNull();

    emit({ type: 'stopping' });
    expect(screen.getByText(/Finishing the recording and the report/)).toBeTruthy();

    emit({ type: 'end', status: 'cancelled' });
    expect(screen.queryByText(/Finishing the recording/)).toBeNull();
  });

  it('keeps the empty state for the two moments with no steps to show', async () => {
    stubEnv();
    renderRunView();
    // Before any run.
    expect(await screen.findByText('Steps appear here during a run.')).toBeTruthy();

    fireEvent.click(await screen.findByLabelText('Run "Plain test"'));
    await waitFor(() => expect(sockets).toHaveLength(1));
    // Queued behind another run: no action yet, and the wait is the news.
    emit({ type: 'status', status: 'queued', position: 1, concurrency: 2 });
    expect(screen.getByText('Steps start arriving once the run gets a slot.')).toBeTruthy();
  });

  it('offers the report and the run page, and no recording toggle', async () => {
    await startPlainRun();
    emit({ type: 'status', status: 'running' });
    emit({ type: 'recording' });
    emit({ type: 'done', success: true, steps: 2 });
    emit({ type: 'end', status: 'passed' });

    expect(screen.getByText('Full report')).toBeTruthy();
    expect(screen.queryByText('Watch recording')).toBeNull();
    // The stage stays on the last live frame — the recording is a click away
    // on /runs/<id>, not a second thing this view can swap itself into.
    expect(screen.queryByText('Session recording')).toBeNull();
  });

  it('still plays a demo replay in the stage', async () => {
    stubEnv();
    const { container } = renderRunView({ db: true, auth_mode: 'demo' });
    fireEvent.click(await screen.findByLabelText('Run "Plain test"'));
    await waitFor(() => expect(sockets).toHaveLength(1));

    emit({ type: 'status', status: 'running' });
    emit({ type: 'recording', demo: true });

    expect(container.querySelector('.stage-main video')).toBeTruthy();
    expect(screen.getByText('Session recording')).toBeTruthy();
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

// US-079. The fork worth pinning is what the buttons do to a run that is still
// going: a pause must not read as a stop, a hint must reach the server with the
// text that was typed, and the held state has to come from the server's own
// event rather than from the click — two tabs watching one run would otherwise
// disagree about whether it is held.
describe('RunView steering a live run (US-079)', () => {
  async function startedRun() {
    const calls = stubEnv();
    renderRunView();
    fireEvent.click(await screen.findByLabelText('Run "Plain test"'));
    await waitFor(() => expect(sockets.length).toBe(1));
    emit({ type: 'status', status: 'running' });
    return calls;
  }

  it('pauses on the server\'s word, not on the click', async () => {
    const calls = await startedRun();

    fireEvent.click(await screen.findByText('Pause'));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/pause') && c.method === 'POST')).toBe(true)
    );
    // Still offering Pause: the request landed, but nothing says the run is
    // held until the relay does.
    expect(screen.queryByText('Resume')).toBeNull();

    emit({ type: 'paused', until: new Date(Date.now() + 600_000).toISOString() });
    expect(await screen.findByText('Resume')).toBeTruthy();
    expect(screen.getByText(/Held before the next action/)).toBeTruthy();

    emit({ type: 'resumed' });
    expect(await screen.findByText('Pause')).toBeTruthy();
  });

  it('sends a hint with the typed text, and shows it as activity', async () => {
    const calls = await startedRun();

    const box = await screen.findByLabelText('Tell the run what to do');
    fireEvent.change(box, { target: { value: 'the button is in the account menu' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      const hint = calls.find((c) => c.url.endsWith('/hint'));
      expect(hint?.body).toEqual({ text: 'the button is in the account menu' });
    });
    // Cleared, so a second Enter cannot send the same sentence twice.
    expect(box.value).toBe('');

    // The row is the server's echo, not the click — the same event a second
    // viewer of this run is replayed.
    emit({ type: 'hint', text: 'the button is in the account menu', elapsed: 12 });
    expect(
      await screen.findByText('You told the run: the button is in the account menu')
    ).toBeTruthy();
  });

  it('offers no steering once the run has ended', async () => {
    await startedRun();
    expect(await screen.findByText('Pause')).toBeTruthy();

    emit({ type: 'done', success: true, steps: 1 });
    emit({ type: 'end', status: 'passed' });

    await waitFor(() => expect(screen.queryByText('Pause')).toBeNull());
    expect(screen.queryByLabelText('Tell the run what to do')).toBeNull();
  });
});

// US-081. The panel was gated on a truthy `token` in the first build and was
// therefore invisible in both of the modes most people run: a signed-in user
// authenticates with a cookie and an open instance has no token at all, so
// `token` is `''` for both. Every other view passes that same empty string to
// `api()`, which omits the header — so the gate was the only thing reading it as
// "not authenticated".
describe('Run memory panel (US-081)', () => {
  it.each([
    ['a token instance', 't'],
    ['a cookie session or an open instance', ''],
  ])('is reachable when editing a saved test on %s', async (_label, token) => {
    stubEnv();
    renderRunView({ db: true }, token);
    fireEvent.click((await screen.findAllByLabelText('Edit'))[0]);
    await screen.findByText('Edit test');
    expect(await screen.findByText('Run memory')).toBeTruthy();
  });

  it('is not there at all until the test has learned something', async () => {
    // The feature is automatic and safe to ignore, so a test that has learned
    // nothing gets no panel — not an empty drawer you open once to find out it
    // never mattered.
    stubEnv();
    const learned = MEMORY.learned;
    MEMORY.learned = { successful_approach: [], avoid_next_time: [], orientation: [] };
    try {
      renderRunView();
      fireEvent.click((await screen.findAllByLabelText('Edit'))[0]);
      await screen.findByText('Edit test');
      expect(screen.queryByText('Run memory')).toBeNull();
    } finally {
      MEMORY.learned = learned;
    }
  });

  it('stays shut until it is asked for', async () => {
    // The feature is automatic, so the panel is a heading and nothing else
    // until someone opens it — no summary line competing with the fields above.
    stubEnv();
    renderRunView();
    fireEvent.click((await screen.findAllByLabelText('Edit'))[0]);
    await screen.findByText('Edit test');
    expect(await screen.findByText('Run memory')).toBeTruthy();
    expect(screen.queryByText('What worked')).toBeNull();
  });

  it('shows a lesson and offers to remove it, but never to write one', async () => {
    const calls = stubEnv();
    renderRunView();
    fireEvent.click((await screen.findAllByLabelText('Edit'))[0]);
    await screen.findByText('Edit test');
    fireEvent.click(await screen.findByText('Run memory'));

    expect(await screen.findByText('Open Billing from the account menu')).toBeTruthy();
    fireEvent.click(await screen.findByLabelText('Remove this lesson'));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/lessons/a1'))).toBe(true)
    );
    // A lesson means a trace produced it, so there is nothing here that sends
    // one — the only writes this panel can make are deletions.
    expect(calls.some((c) => c.url.includes('/memory') && ['PUT', 'POST'].includes(c.method))).toBe(
      false
    );
  });

  it('offers to re-apply lessons an edit set aside', async () => {
    // The save-time prompt is a convenience, not the only chance. Dismissing it
    // by accident must not strand a notebook, so the answer is also here, where
    // a person would look for it afterwards.
    const calls = stubEnv();
    MEMORY.withheld = 'inputs_changed';
    MEMORY.supplied = null;
    try {
      renderRunView();
      fireEvent.click((await screen.findAllByLabelText('Edit'))[0]);
      await screen.findByText('Edit test');
      fireEvent.click(await screen.findByText('Run memory'));
      fireEvent.click(await screen.findByText('These still apply'));
      await waitFor(() =>
        expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/memory/keep'))).toBe(true)
      );
    } finally {
      MEMORY.withheld = null;
      MEMORY.supplied = MEMORY.learned;
    }
  });

  it('offers it only when there is something set aside', async () => {
    stubEnv();
    renderRunView();
    fireEvent.click((await screen.findAllByLabelText('Edit'))[0]);
    await screen.findByText('Edit test');
    fireEvent.click(await screen.findByText('Run memory'));
    expect(await screen.findByText('Clear')).toBeTruthy();
    expect(screen.queryByText('These still apply')).toBeNull();
  });

  it('says what the next run gets once it is open', async () => {
    stubEnv();
    MEMORY.withheld = 'inputs_changed';
    MEMORY.supplied = null;
    try {
      renderRunView();
      fireEvent.click((await screen.findAllByLabelText('Edit'))[0]);
      await screen.findByText('Edit test');
      fireEvent.click(await screen.findByText('Run memory'));
      expect(
        await screen.findByText('Set aside after an edit — the next run goes cold and relearns')
      ).toBeTruthy();
    } finally {
      MEMORY.withheld = null;
      MEMORY.supplied = MEMORY.learned;
    }
  });
});

// US-081: what happens to a notebook when the test under it is edited.
describe('an edit asks about what the test learned (US-081)', () => {
  async function editAndSave(memory) {
    const calls = stubEnv();
    const fetchImpl = global.fetch;
    vi.stubGlobal('fetch', (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('/api/tests/') && (init.method || 'GET') === 'PUT') {
        calls.push({ url, method: 'PUT' });
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ memory }) });
      }
      return fetchImpl(input, init);
    });
    renderRunView();
    fireEvent.click((await screen.findAllByLabelText('Edit'))[0]);
    await screen.findByText('Edit test');
    fireEvent.click(screen.getByText('Save changes'));
    return calls;
  }

  it('keeps the lessons when the person says they still apply', async () => {
    // The hash knows the instructions changed and never whether that changed the
    // flow. A typo fix and a test repointed at another app look the same to it,
    // so the person who made the edit is asked.
    const calls = await editAndSave({ invalidated: true, lessons: 2 });
    fireEvent.click(await screen.findByText('Keep lessons'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/memory/keep'))).toBe(true)
    );
  });

  it('throws them away when the person starts fresh', async () => {
    // A button saying "start fresh" should not leave the lessons sitting in the
    // panel afterwards.
    const calls = await editAndSave({ invalidated: true, lessons: 2 });
    fireEvent.click(await screen.findByText('Start fresh'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/memory'))).toBe(true)
    );
    expect(calls.some((c) => c.url.endsWith('/memory/keep'))).toBe(false);
  });

  it('deletes nothing when the dialog is merely dismissed', async () => {
    // Escape, the X and the scrim all land here, and throwing away a notebook
    // because somebody dismissed a dialog is the wrong kind of surprise. The
    // lessons stay, unused, until the next passing run replaces them.
    const calls = await editAndSave({ invalidated: true, lessons: 2 });
    await screen.findByText('Start fresh');
    fireEvent.click(screen.getByLabelText('Close'));
    await waitFor(() => expect(screen.queryByText('Start fresh')).toBeNull());
    // Reads are fine and expected — the panel in the edit dialog fetches one.
    // What must not happen is a write.
    expect(calls.some((c) => c.url.includes('/memory') && c.method !== 'GET')).toBe(false);
  });

  it('says nothing when the edit left the flow alone', async () => {
    // Most edits — a rename, a step ceiling, the model. A prompt here would be
    // exactly the nagging the story refuses.
    await editAndSave({ invalidated: false, lessons: 2 });
    await waitFor(() => expect(screen.queryByText('Edit test')).toBeNull());
    expect(screen.queryByText('Keep what this test learned?')).toBeNull();
  });

  it('says nothing when there is nothing to lose', async () => {
    await editAndSave({ invalidated: true, lessons: 0 });
    await waitFor(() => expect(screen.queryByText('Edit test')).toBeNull());
    expect(screen.queryByText('Keep what this test learned?')).toBeNull();
  });
});
