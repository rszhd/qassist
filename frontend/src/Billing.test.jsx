// @vitest-environment jsdom
//
// US-022 frontend assertion. The server half of "a self-hoster sees no
// billing" is pinned by billing-off.test.js; this is the half it cannot see —
// with STRIPE_* unset /api/health reports no `billing`, and the Settings
// dialog must then be exactly the dialog it was before this story, having
// asked the server nothing about subscriptions.
//
// The rest is the state table the panel renders: what each subscription status
// offers you, and that an exempt account is told why it is never asked to pay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App.jsx';

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HEALTH = { auth: true, auth_mode: 'multi', db: true, agent_ready: true, mail: true };

// Every request the shell makes in multi mode, plus whatever the test wants
// billing to answer. Returns the call log so a test can assert on what was
// *not* asked as well as what was.
function stubApi({ health = HEALTH, billingStatus, checkoutUrl = 'https://checkout.stripe.test/s1' }) {
  const calls = [];
  vi.stubGlobal('fetch', (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method || 'GET' });
    const routes = {
      '/api/health': health,
      '/api/auth/me': { id: 'u1', email: 'dev@example.com' },
      '/api/account/openai-key': { set: false },
      '/api/keys': { keys: [] },
      '/api/tests': { tests: [] },
      '/api/projects': { projects: [] },
      '/api/billing/status': billingStatus,
      '/api/billing/checkout': { url: checkoutUrl },
    };
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    const body = match ? routes[match] : {};
    return Promise.resolve({ ok: !!match, status: match ? 200 : 404, json: async () => body });
  });
  return calls;
}

async function openSettings() {
  // Multi mode renders nothing until /api/auth/me resolves, so the shell mounts
  // twice and a gear grabbed from the first pass is detached by the time it is
  // clicked. The view nav only exists once health has landed — i.e. after that
  // second mount — so waiting on it is what makes the click land.
  await screen.findByText('History');
  fireEvent.click(screen.getByLabelText('Settings'));
  return screen.findByText('Settings', { selector: 'h2' });
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>
  );
}

describe('Billing panel (US-022)', () => {
  it('renders nothing and fetches nothing when the instance does not bill', async () => {
    const calls = stubApi({ health: { ...HEALTH, billing: false } });
    renderApp();
    await openSettings();

    // Covers both places the word appears when billing is on: the panel's
    // label and the health facts row.
    expect(screen.queryAllByText('Billing')).toHaveLength(0);
    expect(screen.queryByText('Subscribe')).toBeNull();
    // The panel is what fetches, so its absence is provable from the wire.
    expect(calls.filter((c) => c.url.startsWith('/api/billing'))).toHaveLength(0);
    // …and the dialog is otherwise unchanged.
    expect(screen.getByText('OpenAI key')).toBeTruthy();
  });

  it('offers Subscribe with no subscription, and posts checkout when clicked', async () => {
    const calls = stubApi({
      health: { ...HEALTH, billing: true },
      billingStatus: {
        entitled: false,
        exempt: false,
        status: null,
        current_period_end: null,
        manageable: false,
      },
    });
    // jsdom's location is unforgeable, so the whole object is swapped rather
    // than the method spied — checkout ends in a real navigation to Stripe.
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, protocol: 'http:', host: 'localhost', search: '' });
    renderApp();
    await openSettings();

    expect(await screen.findByText(/No subscription yet/)).toBeTruthy();
    // Nothing to manage before a first checkout — the portal would 409.
    expect(screen.queryByText('Manage billing')).toBeNull();

    fireEvent.click(screen.getByText('Subscribe'));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/billing/checkout' && c.method === 'POST')).toBe(true)
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/s1'));
  });

  it('offers only Manage billing while the subscription is active', async () => {
    stubApi({
      health: { ...HEALTH, billing: true },
      billingStatus: {
        entitled: true,
        exempt: false,
        status: 'active',
        current_period_end: '2026-08-25T00:00:00.000Z',
        manageable: true,
      },
    });
    renderApp();
    await openSettings();

    expect(await screen.findByText(/Subscription active/)).toBeTruthy();
    expect(screen.getByText('Manage billing')).toBeTruthy();
    expect(screen.queryByText('Subscribe')).toBeNull();
    expect(screen.queryByText('Resubscribe')).toBeNull();
  });

  it('says Resubscribe, not Subscribe, to an account that used to pay', async () => {
    stubApi({
      health: { ...HEALTH, billing: true },
      billingStatus: {
        entitled: false,
        exempt: false,
        status: 'canceled',
        current_period_end: '2026-07-01T00:00:00.000Z',
        manageable: true,
      },
    });
    renderApp();
    await openSettings();

    expect(await screen.findByText(/Subscription cancelled/)).toBeTruthy();
    expect(screen.getByText('Resubscribe')).toBeTruthy();
    expect(screen.getByText('Manage billing')).toBeTruthy();
  });

  it('keeps a past_due subscription reassuring while its paid period lasts', async () => {
    stubApi({
      health: { ...HEALTH, billing: true },
      billingStatus: {
        entitled: true,
        exempt: false,
        status: 'past_due',
        current_period_end: '2026-08-01T00:00:00.000Z',
        manageable: true,
      },
    });
    renderApp();
    await openSettings();

    expect(await screen.findByText(/Runs keep working until/)).toBeTruthy();
    // Still entitled, so there is nothing to re-buy — only a card to fix.
    expect(screen.queryByText('Resubscribe')).toBeNull();
    expect(screen.getByText('Manage billing')).toBeTruthy();
  });

  it('tells an exempt account why it is never asked to pay', async () => {
    stubApi({
      health: { ...HEALTH, billing: true },
      billingStatus: {
        entitled: true,
        exempt: true,
        status: null,
        current_period_end: null,
        manageable: false,
      },
    });
    renderApp();
    await openSettings();

    expect(await screen.findByText(/exempt list/)).toBeTruthy();
    expect(screen.queryByText('Subscribe')).toBeNull();
    expect(screen.queryByText('Manage billing')).toBeNull();
  });
});
