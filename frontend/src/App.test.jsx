// @vitest-environment jsdom
//
// Mount smoke test (US-034). `npm run build` type-checks but never renders, so
// a component that throws on mount — a bad destructure, a removed ui.jsx
// export, a hook misuse — ships green. This renders the real shell against a
// stubbed API and asserts it comes up, which is the class of break the build
// can't see. The mount cases are deliberately shallow: no interaction, no API
// contract. The demo case below is the exception — what shipped broken there
// was which credential the shell believes it needs, and that is only visible
// once rendered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App.jsx';

// jsdom ships no matchMedia; App's theme effect reads it on mount. Report no
// light preference — the app's default is dark anyway.
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

// Every view fetches on mount, so an unstubbed fetch would throw under each
// render. Route by URL prefix and hand back the shapes the shell reads; an
// unknown path 404s rather than hanging.
function stubApi(routes) {
  vi.stubGlobal('fetch', (input) => {
    const url = typeof input === 'string' ? input : input.url;
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    const body = match ? routes[match] : {};
    return Promise.resolve({ ok: !!match, status: match ? 200 : 404, json: async () => body });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App shell', () => {
  it('mounts with the control plane up and shows the view nav', async () => {
    stubApi({
      '/api/health': { auth: false, db: true, mail: false },
      '/api/tests': { tests: [] },
      '/api/projects': { projects: [] },
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    // Awaited, not synchronous: the shell renders nothing until /api/health
    // answers, because what a stranger is allowed to see is derived from it.
    expect(await screen.findByLabelText('QAssist')).toBeTruthy();
    // The nav only appears once /api/health reports a DB, so finding it proves
    // the health fetch resolved and TopBar re-rendered on it.
    expect(await screen.findByText('History')).toBeTruthy();
  });

  // US-040: the demo deployment sets a WORKER_API_TOKEN it never consults, so
  // health.auth is true there. Gating the UI on that alone put a "token needed"
  // wall in front of every visitor of a deployment whose whole point is that
  // nobody needs a credential — the sandbox cookie is the credential.
  it('never asks a demo visitor for a token, even with one configured', async () => {
    stubApi({
      '/api/health': { auth: true, db: true, mail: false, auth_mode: 'demo' },
      '/api/demo/session': { expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      '/api/tests': { tests: [] },
      '/api/projects': { projects: [] },
      '/api/runs': { runs: [] },
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    // The banner proves the demo bootstrap resolved, so the token check below
    // is reading a settled state rather than the pre-health first paint.
    expect(await screen.findByText('Demo — simulated results.')).toBeTruthy();
    expect(screen.queryByText('API token needed')).toBeNull();
    // Every way in stays live: the header button and the empty state's both key
    // off the same needsToken.
    const runButtons = screen.getAllByRole('button', { name: /New run/ });
    expect(runButtons.length).toBeGreaterThan(0);
    expect(runButtons.every((b) => !b.disabled)).toBe(true);

    // …and Settings doesn't contradict that by asking for the same token behind
    // the gear, or reporting the deployment as token-gated.
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    expect(await screen.findByText('Theme')).toBeTruthy();
    expect(screen.queryByText('API token')).toBeNull();
    expect(screen.queryByText('Token required')).toBeNull();
  });

  // The gates that decide what a visitor may see — multi, demo, the onboarding
  // wall — are all derived from `health`, and an unresolved `health` reads as
  // the unauthenticated branch of every one of them. So a shell that renders
  // before health answers shows a signed-out visitor the whole app for a frame
  // and then takes it away: the Run view flashed over the login screen, and
  // again over the onboarding wall while /api/billing/status was in flight.
  // Asserted synchronously, because a frame is all the bug ever was.
  it('shows no app frame before it knows the visitor is signed out', async () => {
    stubApi({
      '/api/health': { auth: false, db: true, mail: false, auth_mode: 'multi' },
      '/api/tests': { tests: [] },
      '/api/projects': { projects: [] },
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: /New run/ })).toBeNull();
    expect(screen.queryByLabelText('QAssist')).toBeNull();

    // /api/auth/me is unstubbed, so it 404s — no session, which is the login
    // screen. Nothing but it was ever painted.
    expect(await screen.findByRole('button', { name: /Send sign-in link/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New run/ })).toBeNull();
  });

  it('mounts with no control plane and hides the nav', async () => {
    stubApi({ '/api/health': { auth: false, db: false, mail: false } });

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByLabelText('QAssist')).toBeTruthy();
    expect(screen.queryByText('History')).toBeNull();
  });
});
