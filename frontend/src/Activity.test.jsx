// @vitest-environment jsdom
//
// The step list is newest-first, and that is the one thing about it worth
// pinning: it is invisible to the build, both views share this component, and
// getting it backwards is the kind of regression you only notice mid-run.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ActivityLog from './Activity.jsx';

afterEach(cleanup);

const steps = [
  { step: 1, next_goal: 'Open the login page' },
  { step: 2, next_goal: 'Fill the credentials' },
  { type: 'progress', message: 'Still working' },
  { step: 3, next_goal: 'Reach the dashboard' },
];

describe('ActivityLog', () => {
  it('renders steps newest first, progress events included', () => {
    render(<ActivityLog steps={steps} />);

    const rendered = [...document.querySelectorAll('.step-goal')].map((el) => el.textContent);
    expect(rendered).toEqual([
      'Reach the dashboard',
      'Still working',
      'Fill the credentials',
      'Open the login page',
    ]);
  });

  it('keeps each step numbered by arrival, not by row', () => {
    render(<ActivityLog steps={steps} />);

    // Descending, because the newest step sits at the top — a row's number is
    // the step's own, never its position in the list.
    const numbers = [...document.querySelectorAll('.step-n')].map((el) => el.textContent);
    expect(numbers).toEqual(['3', '···', '2', '1']);
  });

  it('renders nothing but the container for a run with no steps', () => {
    render(<ActivityLog steps={[]} />);

    expect(document.querySelectorAll('.log-item')).toHaveLength(0);
    expect(screen.queryByText('…')).toBeNull();
  });
});
