// @vitest-environment jsdom
//
// Mount smoke test (US-034) for the run detail card — the piece History and the
// run page both render. Passing `liveSteps` takes the fetch-on-mount path out,
// so this is a pure render over a canned run row: it proves the card, its
// status badge and the verdict stats come up without throwing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RunDetail from './RunDetail.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// jsdom implements no layout, so this exists in every browser and in no test.
HTMLElement.prototype.scrollIntoView = () => {};

const run = {
  id: 'run-1',
  test_name: 'Checkout smoke',
  status: 'passed',
  success: true,
  steps_count: 4,
  started_at: '2026-07-24T10:00:00Z',
  finished_at: '2026-07-24T10:01:30Z',
  created_at: '2026-07-24T10:00:00Z',
  trigger: 'manual',
  start_url: 'https://example.com',
  goal: 'Buy one widget and reach the confirmation page.',
  report_status: 'ready',
  has_recording: false,
};

describe('RunDetail', () => {
  it('renders a finished run from its row without fetching', () => {
    render(
      <MemoryRouter>
        <RunDetail run={run} token="t" onError={() => {}} liveSteps={[]} />
      </MemoryRouter>
    );

    expect(screen.getByText('Checkout smoke')).toBeTruthy();
    expect(screen.getByText('passed')).toBeTruthy();
    expect(screen.getByText('Pass')).toBeTruthy();
    expect(screen.getByText('Instructions')).toBeTruthy();
    expect(screen.getByText(run.goal)).toBeTruthy();
  });

  // The player and the step log are the run page's; the History panel only
  // picks a run. The PDF is the exception — it opens in a new tab, so the
  // narrow column is no reason to make someone open the page to reach it.
  it('offers the report but no recording or activity in the panel', () => {
    render(
      <MemoryRouter>
        <RunDetail
          run={{ ...run, has_recording: true }}
          token="t"
          onError={() => {}}
          liveSteps={[{ type: 'step', action: 'click', detail: 'Buy now' }]}
          reports
        />
      </MemoryRouter>
    );

    expect(screen.getByText('PDF report')).toBeTruthy();
    expect(screen.queryByText('Session recording')).toBeNull();
    expect(screen.queryByText('Activity')).toBeNull();
  });

  // REPORTS_ENABLED off means no PDF is ever rendered, so the button would be
  // permanently disabled with nothing to explain itself — it stays absent, on
  // both surfaces.
  it('offers no report on either surface when reports are disabled', () => {
    for (const layout of ['panel', 'page']) {
      const { unmount } = render(
        <MemoryRouter>
          <RunDetail run={run} token="t" onError={() => {}} liveSteps={[]} layout={layout} />
        </MemoryRouter>
      );
      expect(screen.queryByText('PDF report')).toBeNull();
      unmount();
    }
  });

  // The page arrangement drops the run's own title and status because RunPage's
  // header already carries both — the duplication is the thing being prevented,
  // so it's what the test pins.
  it('renders the page layout without repeating the title RunPage already shows', () => {
    render(
      <MemoryRouter>
        <RunDetail run={run} token="t" onError={() => {}} liveSteps={[]} layout="page" reports />
      </MemoryRouter>
    );

    expect(screen.queryByText('Checkout smoke')).toBeNull();
    expect(screen.queryByText('passed')).toBeNull();

    // Same blocks as the panel, rearranged — not a second copy of them.
    expect(screen.getByText('Instructions')).toBeTruthy();
    expect(screen.getAllByText(run.goal)).toHaveLength(1);
    expect(screen.getByText('Pass')).toBeTruthy();
    expect(screen.getByText('PDF report')).toBeTruthy();
  });

  // The player is the page, not a thing behind a button: a run with a recording
  // opens with it mounted, and a pruned run — whose file went with the rest of
  // its artifacts — gets no player at all rather than one that 404s.
  it('mounts the player on the page for a run that has a recording', () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <RunDetail
          run={{ ...run, has_recording: true }}
          token="t"
          onError={() => {}}
          liveSteps={[]}
          layout="page"
        />
      </MemoryRouter>
    );

    expect(screen.getByText('Session recording')).toBeTruthy();
    expect(container.querySelector('video')?.getAttribute('src')).toContain(
      `/api/runs/${run.id}/recording`
    );

    rerender(
      <MemoryRouter>
        <RunDetail
          run={{ ...run, has_recording: true, artifacts_deleted_at: '2026-08-01T10:00:00Z' }}
          token="t"
          onError={() => {}}
          liveSteps={[]}
          layout="page"
        />
      </MemoryRouter>
    );

    expect(container.querySelector('video')).toBeNull();
  });

  // US-076. The page owns the player, so it is the page that turns a row's
  // `video_seconds` into a seek — and the rows only become buttons because a
  // player is there to receive one.
  it('seeks the player from a step row, and offers no seek without a player', () => {
    const seeked = [];
    const step = { step: 1, elapsed: 41, next_goal: 'Open the cart', video_seconds: 12.5 };
    // jsdom has no playback, so a seek reaches the property and stops there.
    vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set').mockImplementation(
      (value) => seeked.push(value)
    );
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    const { rerender } = render(
      <MemoryRouter>
        <RunDetail
          run={{ ...run, has_recording: true }}
          token="t"
          onError={() => {}}
          liveSteps={[step]}
          layout="page"
        />
      </MemoryRouter>
    );

    fireEvent.click(document.querySelector('.log-item'));
    // 12.5, not 41: the row carries both clocks and seeks the video's.
    expect(seeked).toEqual([12.5]);

    // Same step, same mapping — the run just has no recording to jump into.
    rerender(
      <MemoryRouter>
        <RunDetail
          run={{ ...run, has_recording: false }}
          token="t"
          onError={() => {}}
          liveSteps={[step]}
          layout="page"
        />
      </MemoryRouter>
    );

    expect(document.querySelector('.log-item').tagName).toBe('DIV');
    expect(screen.getByText(step.next_goal)).toBeTruthy();
  });

  // A seek that shows a sliver of the frame has not shown you the moment. The
  // scroll target is the whole browser chrome rather than the <video>, and it
  // only runs when part of that frame is off screen — a row clicked with the
  // player in view must not move the page under the pointer.
  it('scrolls the whole frame into view, and only when it is not already whole', () => {
    const scrolled = [];
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function record() {
      scrolled.push(this);
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <RunDetail
          run={{ ...run, has_recording: true }}
          token="t"
          onError={() => {}}
          liveSteps={[{ step: 1, elapsed: 41, next_goal: 'Open the cart', video_seconds: 12.5 }]}
          layout="page"
        />
      </MemoryRouter>
    );

    // jsdom lays nothing out, so the frame's box is the test's to state.
    const frame = document.querySelector('.detail-screen');
    frame.getBoundingClientRect = () => ({ top: 40, bottom: window.innerHeight + 200 });
    fireEvent.click(document.querySelector('.log-item'));
    expect(scrolled).toEqual([frame]);

    frame.getBoundingClientRect = () => ({ top: 40, bottom: window.innerHeight - 20 });
    fireEvent.click(document.querySelector('.log-item'));
    expect(scrolled).toEqual([frame]);
  });

  // US-078 tier 1. The page states Duration and the step times in wall clock
  // and the scrub bar in video time, and unaided a reader concludes either that
  // the recording was cut short or that the step times are wrong. The sentence
  // rides with the player, so it is absent exactly when the player is.
  it('says what the recording clock is, only where there is a recording', () => {
    const clock = /the recording may be shorter/;
    const { rerender } = render(
      <MemoryRouter>
        <RunDetail
          run={{ ...run, has_recording: true }}
          token="t"
          onError={() => {}}
          liveSteps={[]}
          layout="page"
        />
      </MemoryRouter>
    );
    expect(screen.getByText(clock)).toBeTruthy();

    rerender(
      <MemoryRouter>
        <RunDetail
          run={{ ...run, has_recording: false }}
          token="t"
          onError={() => {}}
          liveSteps={[]}
          layout="page"
        />
      </MemoryRouter>
    );
    expect(screen.queryByText(clock)).toBeNull();
  });

  // US-078 tier 2. The join lives here because this is where both lists are —
  // a diagnostic carries a step number and the step carries `video_seconds`,
  // and no new field goes down the protocol to connect them.
  it('seeks the player from a diagnostics group heading', () => {
    const seeked = [];
    vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set').mockImplementation(
      (value) => seeked.push(value)
    );
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <RunDetail
          run={{ ...run, has_recording: true }}
          token="t"
          onError={() => {}}
          layout="page"
          liveSteps={[
            { step: 1, elapsed: 8, next_goal: 'Open the cart', video_seconds: 2 },
            { step: 2, elapsed: 41, next_goal: 'Pay', video_seconds: 12.5 },
          ]}
          liveDiagnostics={{
            diagnostics: [{ kind: 'request', step: 2, url: 'https://api.test/order', status: 500, count: 1 }],
            dropped: 0,
          }}
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText('Step 2'));
    // The step's first recorded frame, not its wall-clock elapsed.
    expect(seeked).toEqual([12.5]);
  });

  // REPORTS_ENABLED off (the default): /api/health says `reports: false` and no
  // PDF exists for any run, so the offer goes rather than 404ing on click.
  it('offers no PDF on the page when the instance renders none', () => {
    render(
      <MemoryRouter>
        <RunDetail run={run} token="t" onError={() => {}} liveSteps={[]} layout="page" />
      </MemoryRouter>
    );

    expect(screen.queryByText('PDF report')).toBeNull();
    // The rest of the page is untouched — this is one button, not a mode.
    expect(screen.getByText('Instructions')).toBeTruthy();
    expect(screen.getByText('Activity')).toBeTruthy();
  });
});

// US-047. This card is History's and the run page's only lever on a run in
// flight, and it renders the row it was handed — so the two things worth
// pinning are that the button appears exactly while the run is unfinished, and
// that a stopped run reads as stopped with no verdict attached to it.
describe('RunDetail stopping a run (US-047)', () => {
  const live = { ...run, status: 'running', success: null, finished_at: null, report_status: 'none' };

  function renderDetail(props) {
    return render(
      <MemoryRouter>
        <RunDetail run={run} token="t" onError={() => {}} liveSteps={[]} {...props} />
      </MemoryRouter>
    );
  }

  it('offers Stop while the run is unfinished and posts it', async () => {
    const calls = [];
    vi.stubGlobal('fetch', (input, init = {}) => {
      calls.push({ url: input, method: init.method || 'GET' });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    const onStopped = vi.fn();
    renderDetail({ run: live, onStopped });

    fireEvent.click(screen.getByText('Stop run'));

    await waitFor(() => expect(onStopped).toHaveBeenCalled());
    expect(calls).toEqual([{ url: '/api/runs/run-1/stop', method: 'POST' }]);
    // Still disabled: the row is the caller's, so nothing flips until it
    // comes back cancelled.
    expect(screen.getByText('Stopping…').closest('button').disabled).toBe(true);
  });

  it('shows no Stop button for a run that has already ended', () => {
    renderDetail({});
    expect(screen.queryByText('Stop run')).toBeNull();
  });

  it('reads a cancelled run as stopped, with no verdict', () => {
    renderDetail({ run: { ...run, status: 'cancelled', success: null } });

    // The column value is `cancelled`; the word a person is shown is the one
    // the button used.
    const badge = screen.getByText('stopped');
    expect(badge.className).toContain('badge-cancelled');
    expect(screen.queryByText('Pass')).toBeNull();
    expect(screen.queryByText('Fail')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('Stop run')).toBeNull();
  });
});
