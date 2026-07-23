// @vitest-environment jsdom
//
// Mount smoke test (US-034). `npm run build` type-checks but never renders, so
// a component that throws on mount — a bad destructure, a removed ui.jsx
// export, a hook misuse — ships green. This renders the real shell against a
// stubbed API and asserts it comes up, which is the class of break the build
// can't see. It is deliberately shallow: no interaction, no API contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
      '/api/health': { auth: false, db: true, agent_ready: true, mail: false },
      '/api/tests': { tests: [] },
      '/api/projects': { projects: [] },
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(screen.getByText('QAssist')).toBeTruthy();
    // The nav only appears once /api/health reports a DB, so finding it proves
    // the health fetch resolved and TopBar re-rendered on it.
    expect(await screen.findByText('History')).toBeTruthy();
  });

  it('mounts with no control plane and hides the nav', async () => {
    stubApi({ '/api/health': { auth: false, db: false, agent_ready: true, mail: false } });

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText('QAssist')).toBeTruthy();
    expect(screen.queryByText('History')).toBeNull();
  });
});
