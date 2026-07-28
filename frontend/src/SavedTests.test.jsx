// @vitest-environment jsdom
//
// The rail's two navigation aids. Both are progressive in the same way the
// grouping above them is — they appear when there is enough in the rail to need
// them — and both have a failure mode the build can't see: a fold remembered
// when it shouldn't be leaves tests invisible on the next visit, and a filter
// that doesn't override a fold hides its own matches.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import SavedTests from './SavedTests.jsx';

const PROJECT = { id: 'p1', name: 'Checkout' };
const CART = { id: 'm1', name: 'Cart' };
const LOGIN = { id: 'm2', name: 'Login' };

// Eight tests, which is also where the filter box earns its place.
const TESTS = [
  { id: 't1', name: 'Add to cart', start_url: 'https://shop.test/cart', goal: 'g', module_id: 'm1' },
  { id: 't2', name: 'Remove from cart', start_url: 'https://shop.test/cart', goal: 'g', module_id: 'm1' },
  { id: 't3', name: 'Empty cart notice', start_url: 'https://shop.test/cart', goal: 'g', module_id: 'm1' },
  { id: 't4', name: 'Sign in', start_url: 'https://shop.test/login', goal: 'g', module_id: 'm2' },
  { id: 't5', name: 'Wrong password', start_url: 'https://shop.test/login', goal: 'g', module_id: 'm2' },
  { id: 't6', name: 'Reset password', start_url: 'https://shop.test/reset', goal: 'g', module_id: 'm2' },
  { id: 't7', name: 'Homepage loads', start_url: 'https://shop.test/', goal: 'g', module_id: null },
  { id: 't8', name: 'Footer links', start_url: 'https://shop.test/', goal: 'g', module_id: null },
];

function renderRail(props = {}) {
  return render(
    <SavedTests
      tests={TESTS}
      projects={[PROJECT]}
      modules={[CART, LOGIN]}
      suites={[]}
      filter={PROJECT.id}
      setFilter={() => {}}
      activeTestId={null}
      running={false}
      onRun={() => {}}
      onEdit={() => {}}
      onNew={() => {}}
      onRunModule={() => {}}
      onRunSuite={() => {}}
      onCollapse={() => {}}
      {...props}
    />
  );
}

const names = () => screen.queryAllByRole('listitem').map((li) => li.querySelector('.row-name').textContent);
// The fold control is the head's label, so its accessible name *starts* with
// the module name — which is what tells it apart from the `Run all of "Cart"`
// button sitting in the same head.
const FOLD_CART = { name: /^Cart/ };
const fold = () => screen.getByRole('button', FOLD_CART);
const filterBox = () => screen.getByLabelText('Filter tests');
const type = (value) => fireEvent.change(filterBox(), { target: { value } });

afterEach(() => {
  cleanup();
  // The fold is remembered, and the store outlives cleanup() — left set, the
  // next test would render with a module already shut.
  localStorage.clear();
});

describe('SavedTests folding', () => {
  it('opens every module, and remembers only what you fold', () => {
    const { unmount } = renderRail();
    expect(names()).toContain('Add to cart');

    fireEvent.click(fold());
    expect(names()).not.toContain('Add to cart');
    // Folding one module says nothing about the others.
    expect(names()).toContain('Sign in');

    // A remount is the reload: the fold survives, and nothing else was written.
    unmount();
    renderRail();
    expect(names()).not.toContain('Add to cart');
    expect(names()).toContain('Sign in');
    expect(names()).toContain('Homepage loads');
  });

  it('leaves a rail nobody has folded fully open on first render', () => {
    renderRail();
    expect(localStorage.getItem('qassist_rail_collapsed')).toBeNull();
    expect(names()).toHaveLength(TESTS.length);
  });

  it('keeps the module runnable while it is folded', () => {
    renderRail();
    fireEvent.click(fold());
    expect(screen.getByLabelText('Run all of "Cart"').disabled).toBe(false);
    // And still says how many it would run.
    expect(fold().textContent).toContain('3');
  });
});

describe('SavedTests filtering', () => {
  it('matches on name and on start URL, across every group', () => {
    renderRail();

    type('cart');
    // "Add to cart"/"Remove from cart"/"Empty cart notice" by name — and by URL
    // they are the same three, so nothing from Login survives.
    expect(names()).toEqual(['Add to cart', 'Remove from cart', 'Empty cart notice']);

    type('shop.test/login');
    expect(names()).toEqual(['Sign in', 'Wrong password']);
    // A module the search emptied is a miss, not a fold — its head goes too.
    expect(screen.queryByText('Cart')).toBeNull();
  });

  it('overrules a fold, and hands it back when the box is cleared', () => {
    renderRail();
    fireEvent.click(fold());
    expect(names()).not.toContain('Add to cart');

    type('cart');
    expect(names()).toContain('Add to cart');
    // No chevron while searching — a toggle the search overrules is broken.
    expect(screen.queryByRole('button', FOLD_CART)).toBeNull();

    type('');
    expect(names()).not.toContain('Add to cart');
  });

  it('says so when nothing matches, and clears on Escape', () => {
    renderRail();

    type('nothing here');
    expect(screen.getByText('No matches')).toBeTruthy();
    expect(names()).toHaveLength(0);

    fireEvent.keyDown(filterBox(), { key: 'Escape' });
    expect(names()).toHaveLength(TESTS.length);
  });

  it('stays out of the way of a rail small enough to read', () => {
    renderRail({ tests: TESTS.slice(0, 4), modules: [CART, LOGIN] });
    expect(screen.queryByLabelText('Filter tests')).toBeNull();
  });
});

// The pre-US-023 rail: no projects, no modules, no grouping chrome of any kind.
describe('SavedTests with no projects', () => {
  it('is a flat list, with no select and no group heads', () => {
    renderRail({ projects: [], modules: [], filter: 'all' });

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.querySelector('.group-head')).toBeNull();
    expect(names()).toHaveLength(TESTS.length);
    // The filter box is not grouping, and eight rows is where it starts paying.
    expect(screen.getByLabelText('Filter tests')).toBeTruthy();
  });
});
