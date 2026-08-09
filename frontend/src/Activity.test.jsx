// @vitest-environment jsdom
//
// The step list is newest-first, and that is the one thing about it worth
// pinning: it is invisible to the build, both views share this component, and
// getting it backwards is the kind of regression you only notice mid-run.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ActivityLog from './Activity.jsx';

afterEach(cleanup);

const steps = [
  { step: 1, next_goal: 'Open the login page' },
  { step: 2, next_goal: 'Fill the credentials' },
  { type: 'progress', message: 'Still working' },
  { step: 3, next_goal: 'Reach the dashboard' },
];

const timed = [
  { step: 1, next_goal: 'Open the login page', elapsed: 3.4, video_seconds: 1.5 },
  { step: 2, next_goal: 'Fill the credentials', elapsed: 91.8, video_seconds: 9.17 },
];

const rows = () => [...document.querySelectorAll('.log-item')];

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

// US-076. A row carries two clocks and shows neither: `elapsed` is the run's
// and `video_seconds` is the recording's, and a seek must reach for the second.
describe('ActivityLog seeking', () => {
  it('shows no step time, whatever the row carries', () => {
    render(<ActivityLog steps={timed} />);

    expect(document.querySelector('.step-time')).toBeNull();
    expect(screen.queryByText('1:31')).toBeNull();
  });

  it('seeks with video_seconds, never with elapsed', () => {
    // The recording holds only the frames showing a page change, so a step 1:31
    // into a run that sat waiting is 9s into the file. Seeking to 91.8 would
    // land past the end of a short recording, and plausibly wrong on a long one.
    const onSeek = vi.fn();
    render(<ActivityLog steps={timed} onSeek={onSeek} />);

    fireEvent.click(rows()[0]);
    expect(onSeek).toHaveBeenCalledWith(9.17);
  });

  it('leaves a row that has no seek as text, not a dead button', () => {
    // Two ways to get here: the page has no player to seek (no handler), or the
    // run predates US-076 and carries no mapping. Neither falls back to elapsed.
    render(<ActivityLog steps={timed} />);
    expect(rows().map((el) => el.tagName)).toEqual(['DIV', 'DIV']);
    cleanup();

    render(<ActivityLog steps={timed.map(({ video_seconds, ...s }) => s)} onSeek={vi.fn()} />);
    expect(rows().map((el) => el.tagName)).toEqual(['DIV', 'DIV']);
  });

  it('mixes seekable and text rows inside one list', () => {
    // A run that started before the recorder did, or one whose encoder never
    // came up mid-run: the rows that have the mapping still jump.
    const onSeek = vi.fn();
    render(<ActivityLog steps={[{ step: 1, elapsed: 1, next_goal: 'No mapping' }, ...timed]} onSeek={onSeek} />);

    expect(rows().map((el) => el.tagName)).toEqual(['BUTTON', 'BUTTON', 'DIV']);
  });
});
