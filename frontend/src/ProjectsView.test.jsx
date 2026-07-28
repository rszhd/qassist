// @vitest-environment jsdom
//
// The Projects view is master–detail with the URL naming both halves —
// `/projects/<slug>/<section>`. What is asserted here is the navigation that
// buys: a bare path opens something, a deep link opens the section it names,
// only the named section is mounted, and the section survives switching
// projects. The sections' own behaviour belongs to their own files.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProjectsView from './ProjectsView.jsx';

const projects = [
  { id: 'p1', name: 'Storefront', slug: 'storefront', test_count: 3, module_count: 1 },
  { id: 'p2', name: 'Admin', slug: 'admin', test_count: 0, module_count: 0 },
];

const detail = {
  storefront: {
    id: 'p1',
    name: 'Storefront',
    slug: 'storefront',
    test_count: 3,
    modules: [{ id: 'm1', name: 'Checkout', slug: 'checkout', test_count: 2 }],
    suite_count: 2,
    session_count: 1,
    fixture_count: 4,
  },
  admin: {
    id: 'p2',
    name: 'Admin',
    slug: 'admin',
    test_count: 0,
    modules: [],
    suite_count: 0,
    session_count: 0,
    fixture_count: 0,
  },
};

// Exact-path routing, so a request for one project's detail can't be answered
// by the list's stub. An unknown project 404s the way the server does, which
// is what the "renamed or deleted" state is built on.
function stubApi() {
  vi.stubGlobal('fetch', (input) => {
    const url = typeof input === 'string' ? input : input.url;
    const [path, query] = url.split('?');
    const bodies = {
      '/api/projects': { projects },
      '/api/tests': { tests: [] },
      '/api/suites': { suites: [] },
      '/api/projects/p1/sessions': { sessions: [] },
      '/api/projects/p2/sessions': { sessions: [] },
      '/api/projects/p1/fixtures': { fixtures: [], used_bytes: 0, quota_bytes: 100, max_bytes: 10 },
      '/api/projects/p2/fixtures': { fixtures: [], used_bytes: 0, quota_bytes: 100, max_bytes: 10 },
    };
    const slug = path.startsWith('/api/projects/') && !query ? path.split('/')[3] : null;
    const body = slug && detail[slug] ? detail[slug] : bodies[path];
    return Promise.resolve({
      ok: !!body,
      status: body ? 200 : 404,
      json: async () => body || { error: 'not found' },
    });
  });
}

function open(entry) {
  stubApi();
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/projects/:slug?/:tab?" element={<ProjectsView token="t" health={{ mail: true }} />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProjectsView', () => {
  it('opens the first project on a bare path, on the modules section', async () => {
    open('/projects');
    expect(await screen.findByRole('heading', { name: 'Storefront' })).toBeTruthy();
    // The module list, not one of the other three sections.
    expect(await screen.findByText('Checkout')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Modules/ }).getAttribute('aria-current')).toBe('page');
  });

  it('puts what the project holds on the tabs, before any of it is opened', async () => {
    open('/projects/storefront');
    for (const [label, count] of [['Modules', '1'], ['Suites', '2'], ['Sessions', '1'], ['Files', '4']]) {
      const tab = await screen.findByRole('link', { name: new RegExp(`^${label}`) });
      expect(tab.textContent).toBe(`${label}${count}`);
    }
  });

  it('a deep link opens the section it names, and only that one', async () => {
    open('/projects/storefront/sessions');
    expect(await screen.findByText(/No saved sessions/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Sessions/ }).getAttribute('aria-current')).toBe('page');
    // The modules list is not merely hidden — an unopened section is unmounted,
    // so switching sections costs nothing while you are not in them.
    expect(screen.queryByText('Checkout')).toBeNull();
  });

  it('switching projects stays in the section you were working in', async () => {
    open('/projects/storefront/files');
    expect(await screen.findByText(/No files yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: /Admin/ }));

    expect(await screen.findByRole('heading', { name: 'Admin' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Files/ }).getAttribute('aria-current')).toBe('page')
    );
  });

  it('says so when the link points at a project that is gone', async () => {
    open('/projects/deleted-thing/suites');
    expect(await screen.findByText(/That project isn't here/)).toBeTruthy();
    // The rail still lists what does exist, so the way out is one click.
    expect(screen.getByRole('link', { name: /Storefront/ })).toBeTruthy();
  });
});
