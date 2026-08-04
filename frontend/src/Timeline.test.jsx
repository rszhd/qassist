// @vitest-environment jsdom
//
// The strip both History and the Schedules page draw (US-069). It was one
// component private to HistoryView; lifting it out is only worth anything if
// the contract it now has is the one both callers can hold to, so that is what
// is asserted here — order, click, and the mapping History feeds it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Timeline, { runMarks, runCaption, slotMarks, slotCaption } from './Timeline.jsx';

afterEach(cleanup);

const mark = (key, color = 'var(--fill-passed)') => ({ key, color, title: `${key} — passed` });

const bars = (container) => [...container.querySelectorAll('.tl-bar')];

describe('Timeline', () => {
  it('draws nothing when there is nothing to chart', () => {
    const { container } = render(<Timeline marks={[]} caption="ignored" />);
    expect(container.querySelector('.timeline')).toBe(null);
  });

  it('draws marks in the order given, oldest first', () => {
    const { container } = render(
      <Timeline
        marks={[mark('a'), mark('b'), mark('c')]}
        caption="3 slots"
        startLabel="Oldest"
        endLabel="Newest"
      />
    );
    expect(bars(container).map((b) => b.getAttribute('title'))).toEqual([
      'a — passed',
      'b — passed',
      'c — passed',
    ]);
    expect(screen.getByText('Oldest')).toBeTruthy();
    expect(screen.getByText('3 slots')).toBeTruthy();
  });

  it('omits the scale labels a list row has no space for', () => {
    // Opt-in, so the strip on a Schedules row is bars and a tally and nothing
    // else — every bar's tooltip already names its own slot.
    render(<Timeline marks={[mark('a')]} caption="1 slot" />);
    expect(screen.queryByText('Oldest')).toBe(null);
    expect(screen.queryByText('Newest')).toBe(null);
  });

  it('reports the key of the mark that was clicked', () => {
    const onPick = vi.fn();
    const { container } = render(
      <Timeline marks={[mark('a'), mark('b')]} onPick={onPick} selectedKey="b" />
    );
    fireEvent.click(bars(container)[0]);
    expect(onPick).toHaveBeenCalledWith('a');
    expect(bars(container)[1].className).toContain('active');
    expect(bars(container)[0].className).not.toContain('active');
  });

  it('is inert, not broken, when the caller has nothing for a click to do', () => {
    const { container } = render(<Timeline marks={[mark('a')]} />);
    fireEvent.click(bars(container)[0]);
    expect(bars(container)).toHaveLength(1);
  });
});

describe('runMarks', () => {
  const runs = [
    { id: 'newest', status: 'failed', success: false, created_at: '2026-08-03T02:00:00Z' },
    { id: 'middle', status: 'passed', success: true, created_at: '2026-08-02T02:00:00Z' },
    { id: 'oldest', status: 'running', success: null, created_at: '2026-08-01T02:00:00Z' },
  ];

  it('reverses the newest-first list the API returns', () => {
    // History lists newest first and the strip reads left to right, so the
    // mapping is where the flip belongs — the component itself has no opinion.
    expect(runMarks(runs).map((m) => m.key)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('colours each bar by the same table the row dots use', () => {
    const colours = Object.fromEntries(runMarks(runs).map((m) => [m.key, m.color]));
    expect(colours.newest).toBe('var(--fill-failed)');
    expect(colours.middle).toBe('var(--fill-passed)');
    expect(colours.oldest).toBe('var(--fill-running)');
  });

  it('counts only the runs that reached a verdict', () => {
    // The one still running has no verdict to be counted for or against.
    expect(runCaption(runs)).toBe('1/2 passed in this page');
    expect(runCaption([runs[2]])).toBe('No verdicts in this page');
  });
});

describe('slotMarks', () => {
  const recent = [
    { scheduled_for: '2026-08-03T02:00:00Z', status: 'failed', runs: 8, failed: 1 },
    { scheduled_for: '2026-08-02T02:00:00Z', status: 'passed', runs: 8, failed: 0 },
    { scheduled_for: '2026-08-01T02:00:00Z', status: 'running', runs: 1, failed: 0 },
  ];

  it('reverses the newest-first slots the route returns', () => {
    expect(slotMarks(recent).map((m) => m.key)).toEqual([
      '2026-08-01T02:00:00Z',
      '2026-08-02T02:00:00Z',
      '2026-08-03T02:00:00Z',
    ]);
  });

  it('names the failure count first when there is one', () => {
    // A suite's slot: "failed" alone hides whether one member broke or all
    // eight did, and that is the difference between a flake and an outage.
    const titles = Object.fromEntries(slotMarks(recent).map((m) => [m.key.slice(8, 10), m.title]));
    expect(titles['03']).toContain('1 of 8 failed');
    expect(titles['02']).toContain('8 runs, passed');
    expect(titles['01']).toContain('1 run, running');
  });

  it('counts only the slots where everything passed', () => {
    expect(slotCaption(recent)).toBe('1/3 slots passed');
    expect(slotCaption([recent[1]])).toBe('1/1 slot passed');
  });
});
