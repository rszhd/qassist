import { useCallback, useReducer, useRef } from 'react';
import { api } from './api.js';

// Everything the Run view knows about the run it is watching: the state, the
// relay events that move it, and the socket they arrive on. The view keeps the
// layout, the dialogs and the saved-test lists — none of which a run touches.
//
// A reducer rather than ~15 useState calls because `ws.onmessage` is bound once
// when the socket opens and never re-bound, so every `state` it closed over is
// the value from that render. That is why `stopping` used to need a ref beside
// it: the `done` handler had to know about a stop that happened after the
// binding. `dispatch` is stable and the reducer always sees current state, so
// the ref is gone and the two can no longer disagree.

const INITIAL = {
  status: 'idle',
  // US-027: `{ position, concurrency }` while this run sits in the worker's
  // queue, null otherwise. It gates the queued copy rather than `status`
  // alone, because a run is optimistically 'queued' from the moment it is
  // POSTed — only the server knows whether anyone is actually ahead of it.
  waiting: null,
  wsState: 'idle',
  runId: null,
  screenshot: null,
  steps: [],
  result: null,
  error: null,
  // US-028: over the per-user cap. A "wait a moment", not a failure — its own
  // amber notice (the queued-copy family), never the red error banner.
  capNotice: null,
  // US-022: refused for want of a subscription. Also not a failure — but unlike
  // the cap it doesn't clear by waiting, so the notice carries the way out.
  billingNotice: null,
  // True just after Stripe sends the customer back from a completed Checkout.
  subscribed: false,
  // Set when a module run is started: several runs are queued, the viewer can
  // only follow one.
  batch: null,
  activeTestId: null,
  // US-006: the replay player stands in for the live screen. Set only by a
  // demo's `recording` event since US-076 retired the Watch-recording toggle —
  // a real run's recording is reached through /runs/<id>, which opens with the
  // player already in place.
  showRecording: false,
  // US-047: a stop has been asked for and the run has not ended yet.
  stopping: false,
  // US-079: the run is held before its next action. A flag and not a status,
  // exactly as on the server — a paused run is still running.
  paused: false,
  // When the pause budget ends the run if nobody resumes it, as an ISO string
  // off the `paused` event. The server counts it; this is only what the notice
  // reads so the count runs against the viewer's own clock.
  pausedUntil: null,
};

// One relay event applied to the run. The `done` and `error` cases are where a
// stop is honoured, so they read `state.stopping` — see the note above.
function applyEvent(state, evt) {
  switch (evt.type) {
    case 'status':
      return {
        ...state,
        status: evt.status,
        waiting:
          evt.status === 'queued' ? { position: evt.position, concurrency: evt.concurrency } : null,
      };
    case 'frame':
      // Continuous CDP screencast (JPEG) — this is the live video feed.
      return evt.data ? { ...state, screenshot: `data:image/jpeg;base64,${evt.data}` } : state;
    // The three events that land as a row in the activity log, and since
    // US-076 that is all any of them does — the newest row is the current
    // action, so none of them needs a second copy of itself in state.
    // `progress` is long-running tool activity (e.g. waiting for a confirmation
    // email). `blocked` is the navigation fence firing (US-042), which belongs
    // beside the steps rather than in a red banner: the run is still going, and
    // whoever set the allowlist needs to see WHICH url it refused.
    // `hint` joins them (US-079): what a person told the run is activity, and
    // it has to sit among the steps in the order it happened — a hint floating
    // above the log loses the one thing it explains, which step changed after it.
    case 'step':
    case 'progress':
    case 'blocked':
    case 'hint':
      return { ...state, steps: [...state.steps, evt] };
    case 'paused':
      // Durable, like `stopping`: a viewer attaching mid-pause shows the same
      // held run as the tab that asked for it, rather than a run that looks
      // alive and is not moving.
      return { ...state, paused: true, pausedUntil: evt.until };
    case 'resumed':
      return { ...state, paused: false, pausedUntil: null };
    case 'recording':
      // A demo replay carries no live frames — the recording is the stage feed.
      // Show it playing from the start rather than leaving the browser pane on
      // a spinner waiting for a frame that never comes. A real run ignores this
      // event: its recording is on /runs/<id>.
      return evt.demo ? { ...state, showRecording: true } : state;
    case 'stopping':
      // Durable, so a viewer that attaches mid-stop replays it and shows the
      // same "Stopping…" as the tab that asked for it.
      return { ...state, stopping: true };
    case 'done':
      // The agent's self-report does not survive a stop (US-047). browser-use
      // returns history normally out of Agent.stop(), so this event still says
      // `success: true` for a run nobody finished — and unlike the row and the
      // HTTP shape, which the server rewrites through verdictOf(), the relayed
      // event is the agent's own words. Honouring them here is how an aborted
      // run shows a green Passed card. The payload is still kept: it is the
      // partial evidence, and the report is built from the same thing.
      return {
        ...state,
        result: evt,
        status: state.stopping
          ? 'cancelled'
          : evt.success === true
            ? 'passed'
            : evt.success === false
              ? 'failed'
              : 'completed',
      };
    case 'error':
      // An agent torn down mid-action may report an error on its way out. That
      // is the stop working, not a run that broke — no red banner for it.
      if (state.stopping) return { ...state, status: 'cancelled' };
      return { ...state, error: evt.message, status: 'error' };
    case 'end':
      return {
        ...state,
        waiting: null,
        stopping: false,
        paused: false,
        pausedUntil: null,
        status:
          state.status === 'running' || state.status === 'queued' ? evt.status : state.status,
      };
    default:
      return state;
  }
}

export function runReducer(state, action) {
  switch (action.type) {
    case 'event':
      return applyEvent(state, action.event);
    // A new run is starting: everything the last one left behind goes, and the
    // status is optimistically 'queued' until the server says otherwise.
    // `runId` and `wsState` stay — `follow` replaces them a moment later.
    case 'reset':
      return {
        ...state,
        error: null,
        stopping: false,
        paused: false,
        pausedUntil: null,
        capNotice: null,
        billingNotice: null,
        subscribed: false,
        result: null,
        steps: [],
        screenshot: null,
        batch: null,
        showRecording: false,
        waiting: null,
        status: 'queued',
        activeTestId: action.activeTestId ?? null,
      };
    case 'follow':
      return { ...state, runId: action.runId };
    case 'activeTest':
      return { ...state, activeTestId: action.activeTestId };
    case 'batch':
      return { ...state, batch: action.batch };
    case 'ws':
      return { ...state, wsState: action.wsState };
    // Over the per-user cap (US-028): no run started, so drop back to idle and
    // show the amber wait notice rather than the red error state.
    case 'capped':
      return { ...state, capNotice: action.message, status: 'idle', activeTestId: null };
    // 402 from the billing gate (US-022): nothing started, same idle drop as the
    // cap. `subscription_status` off the response says whether this account ever
    // paid, which is the difference between Subscribe and Resubscribe.
    case 'billingRequired':
      return {
        ...state,
        billingNotice: { message: action.message, status: action.subscriptionStatus || null },
        status: 'idle',
        activeTestId: null,
      };
    // A run that could not be started for any other reason: the red banner, and
    // no test left highlighted on the rail.
    case 'failed':
      return { ...state, error: action.message, status: 'error', activeTestId: null };
    case 'setError':
      return { ...state, error: action.message };
    case 'stopRequested':
      return { ...state, stopping: action.on };
    case 'subscribed':
      return { ...state, subscribed: action.on };
    default:
      return state;
  }
}

/**
 * The run the Run view is watching, plus the socket it arrives on. The view
 * POSTs the run itself — the endpoint differs per trigger — then hands the id
 * to `follow`.
 */
export function useRun(token) {
  const [run, dispatch] = useReducer(runReducer, INITIAL);
  const wsRef = useRef(null);

  const follow = useCallback(
    (runId) => {
      dispatch({ type: 'follow', runId });
      if (wsRef.current) wsRef.current.close();
      dispatch({ type: 'ws', wsState: 'connecting' });
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(
        `${proto}://${location.host}/ws?runId=${runId}&token=${encodeURIComponent(token)}`
      );
      ws.onopen = () => dispatch({ type: 'ws', wsState: 'live' });
      ws.onclose = () => dispatch({ type: 'ws', wsState: 'closed' });
      ws.onerror = () => {
        dispatch({ type: 'ws', wsState: 'error' });
        dispatch({
          type: 'setError',
          message: 'WebSocket could not connect — check the token and that the server is reachable.',
        });
      };
      ws.onmessage = (m) => {
        try {
          dispatch({ type: 'event', event: JSON.parse(m.data) });
        } catch {
          /* ignore malformed */
        }
      };
      wsRef.current = ws;
    },
    [token]
  );

  // US-047. Optimistic on purpose: the intent is marked before the server
  // answers, because the point of the button is to stop spending and the
  // feedback has to be immediate. The server's `stopping` broadcast says the
  // same thing a moment later, and the run's own `end` decides the status.
  // A 409 means it finished on its own between the click and the request —
  // nothing went wrong, so it gets no error banner.
  const stop = useCallback(async () => {
    if (!run.runId) return;
    dispatch({ type: 'stopRequested', on: true });
    try {
      await api(`/api/runs/${run.runId}/stop`, { token, method: 'POST' });
    } catch (err) {
      if (err.status === 409) return;
      dispatch({ type: 'stopRequested', on: false });
      dispatch({ type: 'setError', message: `Stop: ${err.message}` });
    }
  }, [run.runId, token]);

  // US-079's three, and the opposite of `stop`'s optimism: pausing spends
  // nothing, so there is no reason to claim it landed before it did. The
  // server's own `paused`/`resumed` broadcast moves the state, which is also
  // what a second tab watching the same run sees. A 409 means the run ended or
  // moved between the click and the request — nothing went wrong.
  const control = useCallback(
    async (route, body) => {
      if (!run.runId) return;
      try {
        await api(`/api/runs/${run.runId}/${route}`, { token, method: 'POST', body });
      } catch (err) {
        if (err.status === 409) return;
        dispatch({ type: 'setError', message: `${route}: ${err.message}` });
      }
    },
    [run.runId, token]
  );
  const pause = useCallback(() => control('pause'), [control]);
  const resume = useCallback(() => control('resume'), [control]);
  const hint = useCallback((text) => control('hint', { text }), [control]);

  // The three start paths share one failure ladder: a cap and a paywall are
  // both "nothing started, try again", and only what is left is a real error.
  const startFailed = useCallback((err, message = err.message) => {
    if (err.status === 429) return dispatch({ type: 'capped', message: err.message });
    if (err.status === 402) {
      return dispatch({
        type: 'billingRequired',
        message: err.message,
        subscriptionStatus: err.payload?.subscription_status,
      });
    }
    dispatch({ type: 'failed', message });
  }, []);

  // Every dispatcher below is wrapped even though its body is one line, because
  // the view puts them in dependency arrays — `setError` reaches `loadTests`,
  // `loadProjects` and three `useProjectList` calls. These replaced `useState`
  // setters, whose identity React keeps stable for exactly this reason; a fresh
  // arrow per render makes those effects refire on the state they just set,
  // which is an infinite render loop rather than a slow one.
  const reset = useCallback((activeTestId) => dispatch({ type: 'reset', activeTestId }), []);
  // The highlighted test was deleted out from under the rail.
  const clearActiveTest = useCallback(
    () => dispatch({ type: 'activeTest', activeTestId: null }),
    []
  );
  const atCap = useCallback((message) => dispatch({ type: 'capped', message }), []);
  const setBatch = useCallback((batch) => dispatch({ type: 'batch', batch }), []);
  const setError = useCallback((message) => dispatch({ type: 'setError', message }), []);
  const setSubscribed = useCallback((on) => dispatch({ type: 'subscribed', on }), []);

  const running = run.status === 'running' || run.status === 'queued';
  const queued = run.status === 'queued' && !!run.waiting;

  return {
    ...run,
    running,
    queued,
    waitingForFirstFrame: running && !queued && !run.screenshot,
    hasFrame: (run.showRecording && !!run.runId) || !!run.screenshot,
    // US-047: a stopped run has no verdict, whatever the `done` event claims.
    stopped: run.status === 'cancelled',
    verdict: run.status === 'cancelled' ? null : run.result?.success ?? null,

    follow,
    stop,
    pause,
    resume,
    hint,
    startFailed,
    reset,
    clearActiveTest,
    atCap,
    setBatch,
    setError,
    setSubscribed,
  };
}
