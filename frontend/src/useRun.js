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

const LAUNCHING = 'Launching browser and loading the page…';

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
  currentAction: null,
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
  // US-006: set by the `recording` event that arrives just before the run
  // ends. `showRecording` swaps the live screen for the replay player.
  hasRecording: false,
  showRecording: false,
  // US-047: a stop has been asked for and the run has not ended yet.
  stopping: false,
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
        currentAction: evt.status === 'running' ? LAUNCHING : state.currentAction,
      };
    case 'start':
      return { ...state, currentAction: LAUNCHING };
    case 'frame':
      // Continuous CDP screencast (JPEG) — this is the live video feed.
      return evt.data ? { ...state, screenshot: `data:image/jpeg;base64,${evt.data}` } : state;
    case 'step':
      return {
        ...state,
        currentAction: evt.next_goal || evt.thinking || evt.evaluation || 'Thinking…',
        steps: [...state.steps, evt],
      };
    case 'progress':
      // Long-running tool activity (e.g. waiting for a confirmation email).
      return { ...state, currentAction: evt.message, steps: [...state.steps, evt] };
    case 'blocked':
      // The navigation fence fired (US-042). Rendered in the activity log
      // beside the steps rather than as a red banner: the run is still going,
      // and whoever set the allowlist needs to see WHICH url it refused.
      return {
        ...state,
        currentAction: `Navigation to ${evt.url} was blocked by this instance`,
        steps: [...state.steps, evt],
      };
    case 'recording':
      // Emitted before done/error, so the button is ready when the run ends.
      // A demo replay carries no live frames — the recording is the stage feed.
      // Show it playing from the start rather than leaving the browser pane on
      // a spinner waiting for a frame that never comes.
      return { ...state, hasRecording: true, showRecording: evt.demo || state.showRecording };
    case 'stopping':
      // Durable, so a viewer that attaches mid-stop replays it and shows the
      // same "Stopping…" as the tab that asked for it.
      return {
        ...state,
        stopping: true,
        currentAction: 'Stopping the run — finishing the recording and the report…',
      };
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
        currentAction: null,
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
      if (state.stopping) return { ...state, currentAction: null, status: 'cancelled' };
      return { ...state, currentAction: null, error: evt.message, status: 'error' };
    case 'end':
      return {
        ...state,
        currentAction: null,
        waiting: null,
        stopping: false,
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
        capNotice: null,
        billingNotice: null,
        subscribed: false,
        result: null,
        steps: [],
        screenshot: null,
        currentAction: null,
        batch: null,
        hasRecording: false,
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
    case 'toggleRecording':
      return { ...state, showRecording: !state.showRecording };
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
  const toggleRecording = useCallback(() => dispatch({ type: 'toggleRecording' }), []);

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
    startFailed,
    reset,
    clearActiveTest,
    atCap,
    setBatch,
    setError,
    setSubscribed,
    toggleRecording,
  };
}
