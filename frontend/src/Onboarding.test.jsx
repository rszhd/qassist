// @vitest-environment jsdom
//
// US-053 — the onboarding wall. Two claims are load-bearing here and neither is
// visible from the server: that a billing instance shows the checklist INSTEAD
// of the app until the account has paid, and that a self-hosted instance
// (STRIPE_* unset, so no `billing` in /api/health) is untouched by any of it —
// same Run view, and not one /api/billing request.
//
// The step order is the other claim: Subscribe is not offered at all until a
// key is stored. The server refusal that makes that real is
// server/test/checkout-key-gate.test.js; this is the affordance half.
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

const HEALTH = { auth: true, auth_mode: 'multi', db: true, mail: true, billing: true };
const NO_SUB = { entitled: false, exempt: false, status: null, current_period_end: null, manageable: false };

/**
 * The shell's requests, with the two answers this story turns on kept mutable:
 * storing a key must unlock step 3 in place, which only means anything if the
 * next read of /api/account/openai-key says something different.
 */
function stubApi({ health = HEALTH, billing = NO_SUB, keySet = false } = {}) {
  const state = { keySet, billing };
  const calls = [];
  vi.stubGlobal('fetch', (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init.method || 'GET';
    calls.push({ url, method });
    if (url.startsWith('/api/account/openai-key') && method === 'PUT') {
      state.keySet = true;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ set: true }) });
    }
    const routes = {
      '/api/health': health,
      '/api/auth/me': { id: 'u1', email: 'dev@example.com' },
      '/api/account/openai-key': { set: state.keySet, updated_at: null },
      '/api/billing/status': state.billing,
      '/api/billing/checkout': { url: 'https://checkout.stripe.test/s1' },
      '/api/billing/portal': { url: 'https://portal.stripe.test/p1' },
      '/api/keys': { keys: [] },
      '/api/tests': { tests: [] },
      '/api/projects': { projects: [] },
    };
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    const body = match ? routes[match] : {};
    return Promise.resolve({ ok: !!match, status: match ? 200 : 404, json: async () => body });
  });
  return { calls, state };
}

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe('Onboarding wall (US-053)', () => {
  it('replaces the app for an account that has never paid', async () => {
    stubApi();
    renderApp();

    expect(await screen.findByText('Two things before your first run')).toBeTruthy();
    // The wall IS the app: no nav to route around it, and no run form behind it.
    expect(screen.queryByText('History')).toBeNull();
    expect(screen.queryByText('New run')).toBeNull();
    // Signing out is the one way past it — a forced flow must not be a trap.
    expect(screen.getByText('Sign out')).toBeTruthy();
  });

  it('locks Subscribe until a key is stored, then unlocks it in place', async () => {
    const { calls } = stubApi();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, protocol: 'http:', host: 'localhost', search: '' });
    renderApp();

    await screen.findByText('Two things before your first run');
    // Step 3 offers nothing at all yet: a subscription without a key buys a
    // product that cannot run.
    // Queried as a BUTTON: the step's own title is the word "Subscribe" too.
    expect(screen.queryByRole('button', { name: 'Subscribe' })).toBeNull();
    expect(screen.getByText(/Available once your key is stored/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test-key-000' } });
    fireEvent.click(screen.getByText('Save'));

    // No reload, no second sign-in: the same screen re-reads its own state.
    const subscribe = await screen.findByRole('button', { name: 'Subscribe' });
    expect(calls.some((c) => c.url === '/api/account/openai-key' && c.method === 'PUT')).toBe(true);

    fireEvent.click(subscribe);
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/billing/checkout' && c.method === 'POST')).toBe(true)
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/s1'));
  });

  it('offers a lapsed account both Resubscribe and the Portal', async () => {
    stubApi({
      keySet: true,
      billing: { entitled: false, exempt: false, status: 'canceled', current_period_end: null, manageable: true },
    });
    renderApp();

    expect(await screen.findByText('Resubscribe')).toBeTruthy();
    // The way to fix a dead card cannot sit behind the paywall it would clear.
    expect(screen.getByText('Manage billing')).toBeTruthy();
  });

  it('does not ask for money twice while Stripe confirms', async () => {
    stubApi({ keySet: true });
    renderApp('/?billing=success');

    expect(await screen.findByText(/Confirming with Stripe/)).toBeTruthy();
    expect(screen.getByText('Confirming…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Subscribe' })).toBeNull();
  });

  it('lets an entitled account straight through to the app', async () => {
    stubApi({
      keySet: true,
      billing: { entitled: true, exempt: false, status: 'active', current_period_end: null, manageable: true },
    });
    renderApp();

    expect(await screen.findByText('History')).toBeTruthy();
    expect(screen.queryByText('Two things before your first run')).toBeNull();
  });

  it('never walls an entitled account whose key was removed later', async () => {
    // The Run view's "Setup needed" banner owns this case. Locking someone out
    // of history they paid for because they rotated a key is the failure.
    stubApi({
      keySet: false,
      billing: { entitled: true, exempt: false, status: 'active', current_period_end: null, manageable: true },
    });
    renderApp();

    expect(await screen.findByText('History')).toBeTruthy();
    expect(await screen.findByText(/No OpenAI key stored/)).toBeTruthy();
  });

  it('leaves a self-hosted instance exactly as it was', async () => {
    const { calls } = stubApi({
      health: { auth: false, db: true, mail: false },
      keySet: false,
    });
    renderApp();

    // No wall, no subscription anything — and the proof is on the wire.
    expect(await screen.findByText('History')).toBeTruthy();
    expect(screen.queryByText('Two things before your first run')).toBeNull();
    expect(calls.filter((c) => c.url.startsWith('/api/billing'))).toHaveLength(0);
  });
});
