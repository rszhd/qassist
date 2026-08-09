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

// US-076. The time is the run's clock and the seek is the video's, and the two
// are carried by different fields on purpose — these pin that a row never
// reaches for the wrong one.
describe('ActivityLog timestamps and seeking', () => {
  it('shows each step time as m:ss, and none for an event without one', () => {
    render(<ActivityLog steps={[...timed, { type: 'progress', message: 'Waiting' }]} />);

    // Newest first, and `progress` carries no `elapsed` — a zero there would be
    // a step time of 0:00 on an event that happened an hour in.
    expect([...document.querySelectorAll('.step-time')].map((el) => el.textContent))
      .toEqual(['1:31', '0:03']);
  });

  it('seeks with video_seconds, never with elapsed', () => {
    // The recording holds only the frames the page repainted, so a run that sat
    // waiting reads 1:31 on the row and 9s into the file. Seeking to 91.8 would
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
    // The time survives the loss of the seek — "when did this happen" is still
    // answerable for a run recorded before the mapping existed.
    expect([...document.querySelectorAll('.step-time')].map((el) => el.textContent))
      .toEqual(['1:31', '0:03']);
  });

  it('mixes seekable and text rows inside one list', () => {
    // A run that started before the recorder did, or one whose encoder never
    // came up mid-run: the rows that have the mapping still jump.
    const onSeek = vi.fn();
    render(<ActivityLog steps={[{ step: 1, elapsed: 1, next_goal: 'No mapping' }, ...timed]} onSeek={onSeek} />);

    expect(rows().map((el) => el.tagName)).toEqual(['BUTTON', 'BUTTON', 'DIV']);
  });
});
