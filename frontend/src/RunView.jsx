import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, Check, CircleStop, Clock, CreditCard, Download, ExternalLink, KeyRound,
  Monitor, PanelLeftOpen, Play, Plus, Undo2, X,
} from 'lucide-react';
import { api, openReport } from './api.js';
import ActivityLog from './Activity.jsx';
import { startCheckout } from './Billing.jsx';
import SavedTests from './SavedTests.jsx';
import { TestDialog, RunVarsDialog } from './RunDialogs.jsx';
import { batchSummary, fillTemplate, referencedNames, useProjectList } from './runHelpers.js';
import { Button, CardHead, EmptyState, PageHeader, Stat } from './ui.jsx';

// The default view: the live stage is the page, with the saved-test rail
// beside it. Creating and editing tests happens in a dialog so the run form
// never competes with the thing you are actually here to watch.
//
// Owns everything about a single run (WS socket, steps, result, report).
export default function RunView({ token, health, keyStatus, visible, needsToken, onOpenSettings, onRunState }) {
  const [goal, setGoal] = useState('Verify the page loads and find the main heading text');
  const [startUrl, setStartUrl] = useState('https://news.ycombinator.com');
  const [status, setStatus] = useState('idle');
  // US-027: `{ position, concurrency }` while this run sits in the worker's
  // queue, null otherwise. It gates the queued copy rather than `status`
  // alone, because a run is optimistically 'queued' from the moment it is
  // POSTed — only the server knows whether anyone is actually ahead of it.
  const [waiting, setWaiting] = useState(null);
  const [wsState, setWsState] = useState('idle');
  const [runId, setRunId] = useState(null);
  const [screenshot, setScreenshot] = useState(null);
  const [currentAction, setCurrentAction] = useState(null);
  const [steps, setSteps] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  // US-028: over the per-user cap. A "wait a moment", not a failure — its own
  // amber notice (the queued-copy family), never the red error banner.
  const [capNotice, setCapNotice] = useState(null);
  // US-022: refused for want of a subscription. Also not a failure — but unlike
  // the cap it doesn't clear by waiting, so the notice carries the way out.
  const [billingNotice, setBillingNotice] = useState(null);
  // True just after Stripe sends the customer back from a completed Checkout.
  const [subscribed, setSubscribed] = useState(false);
  const [tests, setTests] = useState([]);
  const [projects, setProjects] = useState([]);
  // 'all' | 'none' (Ungrouped) | a project id. Drives the ?project_id= filter.
  const [filter, setFilter] = useState('all');
  // Set when a module run is started: several runs are queued, the viewer can
  // only follow one.
  const [batch, setBatch] = useState(null);
  const [activeTestId, setActiveTestId] = useState(null);
  // Which dialog is open: 'run' (ad-hoc), 'create'/'edit' (a saved test), or
  // 'vars' (override a variable'd test's values before it runs). The URL and
  // goal fields are shared with the running state, so the dialog edits them in
  // place; `editing` carries only what a saved test adds on top.
  const [dialog, setDialog] = useState(null);
  const [editing, setEditing] = useState(null);
  // US-035: the variable declarations being edited in the create/edit dialog,
  // and — for the 'vars' dialog — the test being run plus this run's override
  // values (seeded from each variable's default).
  const [variables, setVariables] = useState([]);
  const [runVars, setRunVars] = useState(null);
  const [varValues, setVarValues] = useState({});
  const [savingTest, setSavingTest] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  // The rail opens with the view — the tests are how a run starts, so hiding
  // them behind a strip taxes the common path. What used to make that expensive
  // was the frame shrinking to 728px to pay for it; `--stage-min` holds the
  // frame at 800 now, so the column is affordable and minimizing it is a choice
  // rather than a workaround. Remembered, but written only by `toggleRail`: a
  // `min` persisted on mount is not a preference, and storing one is what made a
  // changed default invisible to every screen that had ever opened the view.
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('qassist_rail_state') !== 'min');
  // US-006: set by the `recording` event that arrives just before the run
  // ends. `showRecording` swaps the live screen for the replay player.
  const [hasRecording, setHasRecording] = useState(false);
  const [showRecording, setShowRecording] = useState(false);
  // US-047: a stop has been asked for and the run has not ended yet. Mirrored
  // into a ref because `handleEvent` is captured by `ws.onmessage` when the
  // socket opens and never re-bound — every read of state inside it is the
  // value from that render. The `done` event has to know, so it is a ref.
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const wsRef = useRef(null);
  const logRef = useRef(null);

  // Back to the newest step, which the log puts at the top.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [steps]);

  useEffect(() => {
    onRunState({ status, wsState, runId });
  }, [status, wsState, runId, onRunState]);

  function toggleRail(open) {
    setRailOpen(open);
    localStorage.setItem('qassist_rail_state', open ? 'open' : 'min');
  }

  // Coming back from Stripe (US-022). Checkout's success/cancel URLs land here
  // on a full page load carrying ?billing=, so it is read once and stripped —
  // a reload should not congratulate you a second time. A cancelled checkout
  // says nothing: backing out of a payment page is not an event.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('billing')) return;
    setSubscribed(params.get('billing') === 'success');
    params.delete('billing');
    const query = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
  }, []);

  const filterProjectId = filter === 'all' || filter === 'none' ? null : filter;

  const loadTests = useCallback(async () => {
    if (!health?.db) return;
    const query = filter === 'all' ? '' : `?project_id=${filter}`;
    try {
      const { tests: rows } = await api(`/api/tests${query}`, { token });
      setTests(rows);
    } catch (err) {
      setError(`Saved tests: ${err.message}`);
    }
  }, [health?.db, token, filter]);

  // Also refetches on the way back from Projects, where groups may have changed.
  useEffect(() => {
    if (visible) loadTests();
  }, [visible, loadTests]);

  const loadProjects = useCallback(async () => {
    if (!health?.db) return;
    try {
      const { projects: rows } = await api('/api/projects', { token });
      setProjects(rows);
      // A project deleted in Projects must not leave a dangling filter.
      setFilter((cur) => (cur === 'all' || cur === 'none' || rows.some((p) => p.id === cur) ? cur : 'all'));
    } catch (err) {
      setError(`Projects: ${err.message}`);
    }
  }, [health?.db, token]);

  useEffect(() => {
    if (visible) loadProjects();
  }, [visible, loadProjects]);

  // Bumped whenever this view comes back into focus, so the lists below
  // refetch after edits made in Projects.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (visible) setRefreshTick((t) => t + 1);
  }, [visible]);

  // Modules of the filtered project (group headers) and of the project the
  // editor currently points at (the picker) — usually the same project, but
  // not while a test is being moved.
  const listModules = useProjectList(
    filterProjectId && `/api/projects/${filterProjectId}/modules`,
    'modules', token, setError, refreshTick
  );
  const editModules = useProjectList(
    editing?.project_id ? `/api/projects/${editing.project_id}/modules` : null,
    'modules', token, setError, refreshTick
  );
  const suites = useProjectList(
    filterProjectId && `/api/suites?project_id=${filterProjectId}`,
    'suites', token, setError, refreshTick
  );
  // The saved sessions of the project the editor points at (US-043). Same
  // shape as editModules, and same reason: a test opts into a session of its
  // own project, so the picker follows the project the write will land in.
  const editSessions = useProjectList(
    editing?.project_id ? `/api/projects/${editing.project_id}/sessions` : null,
    'sessions', token, setError, refreshTick
  );

  function handleEvent(evt) {
    switch (evt.type) {
      case 'status':
        setStatus(evt.status);
        setWaiting(
          evt.status === 'queued' ? { position: evt.position, concurrency: evt.concurrency } : null
        );
        if (evt.status === 'running') setCurrentAction('Launching browser and loading the page…');
        break;
      case 'start':
        setCurrentAction('Launching browser and loading the page…');
        break;
      case 'frame':
        // Continuous CDP screencast (JPEG) — this is the live video feed.
        if (evt.data) setScreenshot(`data:image/jpeg;base64,${evt.data}`);
        break;
      case 'step':
        setCurrentAction(evt.next_goal || evt.thinking || evt.evaluation || 'Thinking…');
        setSteps((s) => [...s, evt]);
        break;
      case 'progress':
        // Long-running tool activity (e.g. waiting for a confirmation email).
        setCurrentAction(evt.message);
        setSteps((s) => [...s, evt]);
        break;
      case 'blocked':
        // The navigation fence fired (US-042). Rendered in the activity log
        // beside the steps rather than as a red banner: the run is still going,
        // and whoever set the allowlist needs to see WHICH url it refused.
        setCurrentAction(`Navigation to ${evt.url} was blocked by this instance`);
        setSteps((s) => [...s, evt]);
        break;
      case 'recording':
        // Emitted before done/error, so the button is ready when the run ends.
        setHasRecording(true);
        // A demo replay carries no live frames — the recording is the stage
        // feed. Show it playing from the start rather than leaving the browser
        // pane on a spinner waiting for a frame that never comes.
        if (evt.demo) setShowRecording(true);
        break;
      case 'stopping':
        // Durable, so a viewer that attaches mid-stop replays it and shows the
        // same "Stopping…" as the tab that asked for it.
        markStopping();
        setCurrentAction('Stopping the run — finishing the recording and the report…');
        break;
      case 'done':
        setResult(evt);
        setCurrentAction(null);
        // The agent's self-report does not survive a stop (US-047). browser-use
        // returns history normally out of Agent.stop(), so this event still says
        // `success: true` for a run nobody finished — and unlike the row and the
        // HTTP shape, which the server rewrites through verdictOf(), the relayed
        // event is the agent's own words. Honouring them here is how an aborted
        // run shows a green Passed card. The payload is still kept: it is the
        // partial evidence, and the report is built from the same thing.
        setStatus(
          stoppingRef.current
            ? 'cancelled'
            : evt.success === true
              ? 'passed'
              : evt.success === false
                ? 'failed'
                : 'completed'
        );
        break;
      case 'error':
        setCurrentAction(null);
        // An agent torn down mid-action may report an error on its way out. That
        // is the stop working, not a run that broke — no red banner for it.
        if (stoppingRef.current) {
          setStatus('cancelled');
          break;
        }
        setError(evt.message);
        setStatus('error');
        break;
      case 'end':
        setCurrentAction(null);
        setWaiting(null);
        setStopping(false);
        setStatus((cur) => (cur === 'running' || cur === 'queued' ? evt.status : cur));
        break;
      default:
        break;
    }
  }

  function markStopping(on = true) {
    stoppingRef.current = on;
    setStopping(on);
  }

  function resetRunState() {
    setError(null);
    markStopping(false);
    setCapNotice(null);
    setBillingNotice(null);
    setSubscribed(false);
    setResult(null);
    setSteps([]);
    setScreenshot(null);
    setCurrentAction(null);
    setBatch(null);
    setHasRecording(false);
    setShowRecording(false);
    setWaiting(null);
    setStatus('queued');
  }

  async function startRun() {
    setDialog(null);
    resetRunState();
    setActiveTestId(null);
    try {
      const { runId: id } = await api('/api/runs', {
        token,
        method: 'POST',
        body: { goal, start_url: startUrl },
      });
      setRunId(id);
      openSocket(id);
    } catch (err) {
      if (err.status === 429) return atCap(err.message);
      if (err.status === 402) return needsSubscription(err);
      setError(err.message);
      setStatus('error');
    }
  }

  // Over the per-user cap (US-028): no run started, so drop back to idle and
  // show the amber wait notice rather than the red error state.
  function atCap(message) {
    setCapNotice(message);
    setStatus('idle');
    setActiveTestId(null);
  }

  // 402 from the billing gate (US-022): nothing started, same idle drop as the
  // cap. `subscription_status` off the response says whether this account ever
  // paid, which is the difference between Subscribe and Resubscribe.
  function needsSubscription(err) {
    setBillingNotice({ message: err.message, status: err.payload?.subscription_status || null });
    setStatus('idle');
    setActiveTestId(null);
  }

  async function subscribe() {
    try {
      await startCheckout();
    } catch (err) {
      setError(err.message);
    }
  }

  // Create or update from whatever the dialog currently holds. max_steps/model
  // aren't in the form, and PUT is a partial update, so they keep their value.
  async function saveTest() {
    const name = (editing?.name || '').trim();
    if (!name) return;
    // The server rejects a secret in start_url only at run time (a secret in a
    // URL is the leak US-034's scrub patches); catch it at save so the UI can't
    // build a test that would 400 on its first run (US-035).
    const urlRefs = referencedNames(startUrl);
    const badSecret = variables.find((v) => v.secret && urlRefs.has(v.name));
    if (badSecret) {
      setError(`Save: secret variable ${badSecret.name} cannot appear in the Start URL`);
      return;
    }
    setSavingTest(true);
    try {
      const body = { name, goal, start_url: startUrl, variables };
      // Send both halves of the grouping: setting project_id alone would clear
      // the module server-side (US-023 decision 4).
      if (projects.length) {
        body.project_id = editing.project_id || null;
        body.module_id = editing.module_id || null;
        // Sent whenever grouping is, so clearing the picker actually clears the
        // opt-in. Scoped server-side to the project this write lands in.
        body.browser_session_id = editing.browser_session_id || null;
      }
      if (editing.id) await api(`/api/tests/${editing.id}`, { token, method: 'PUT', body });
      else await api('/api/tests', { token, method: 'POST', body });
      closeDialog();
      await loadTests();
    } catch (err) {
      setError(`Save: ${err.message}`);
    } finally {
      setSavingTest(false);
    }
  }

  function closeDialog() {
    setDialog(null);
    setEditing(null);
    setRunVars(null);
  }

  function editTest(test) {
    setError(null);
    setEditing({
      id: test.id,
      name: test.name,
      project_id: test.project_id,
      module_id: test.module_id,
      browser_session_id: test.browser_session_id,
    });
    setGoal(test.goal);
    setStartUrl(test.start_url);
    setVariables(test.variables || []);
    setDialog('edit');
  }

  // A new test lands in whatever project is being filtered — the least
  // surprising default when you are already working inside one.
  function newTest() {
    setEditing({ name: '', project_id: filterProjectId, module_id: null });
    setVariables([]);
    setDialog('create');
  }

  async function deleteTest(test) {
    if (!window.confirm(`Delete "${test.name}"?`)) return;
    try {
      await api(`/api/tests/${test.id}`, { token, method: 'DELETE' });
      if (editing?.id === test.id) closeDialog();
      if (activeTestId === test.id) setActiveTestId(null);
      await loadTests();
    } catch (err) {
      setError(`Delete: ${err.message}`);
    }
  }

  // Clicking Run on the rail. A test with no variables runs on one click,
  // exactly as before (US-035 progressive disclosure). A test that declares
  // variables opens the override dialog first, prefilled with each default.
  function onRunTest(test) {
    if (test.variables?.length) {
      setRunVars(test);
      setVarValues(Object.fromEntries(test.variables.map((v) => [v.name, v.value])));
      setDialog('vars');
    } else {
      runSavedTest(test);
    }
  }

  // One-click re-run: the server reads goal/URL off the saved row and resolves
  // variables itself, so we only mirror the (locally substituted) values into
  // the form to show what's running. `overrides` is this run's variable values
  // from the override dialog; undefined ⇒ the test's own defaults.
  async function runSavedTest(test, overrides) {
    // A secret's box opens empty whether or not a value is stored (US-064), so
    // an untouched one must not travel as an override of "". The server reads it
    // that way too, but sending the blank at all would mean the request says
    // something the operator did not.
    if (overrides) {
      overrides = Object.fromEntries(
        Object.entries(overrides).filter(
          ([name, value]) => value !== '' || !test.variables?.find((v) => v.name === name)?.secret
        )
      );
    }
    setDialog(null);
    resetRunState();
    setActiveTestId(test.id);
    setGoal(fillTemplate(test.goal, test.variables, overrides));
    setStartUrl(fillTemplate(test.start_url, test.variables, overrides));
    try {
      const { runId: id } = await api(`/api/tests/${test.id}/run`, {
        token,
        method: 'POST',
        body: { trigger: 'ui', variables: overrides },
      });
      setRunId(id);
      openSocket(id);
    } catch (err) {
      if (err.status === 429) return atCap(err.message);
      if (err.status === 402) return needsSubscription(err);
      setError(err.message);
      setStatus('error');
      setActiveTestId(null);
    }
  }

  // A module or suite run queues one run per member test. The viewer follows
  // the first; the rest run behind it at the server's concurrency limit.
  async function runBatch(kind, group, memberCount) {
    if (!memberCount) return;
    resetRunState();
    setActiveTestId(null);
    try {
      const { runs } = await api(`/api/${kind}s/${group.id}/run`, {
        token,
        method: 'POST',
        body: { trigger: 'ui' },
      });
      // Partial accept (US-028): the batch may come back with some members
      // refused for being over the cap. Follow the first that actually started;
      // if none did, it's the same "wait a moment" as a single over-cap run.
      const started = runs.filter((r) => r.runId);
      const rejected = runs.filter((r) => r.rejected);
      if (started.length === 0) {
        return atCap(
          `You're at your run limit, so none of ${group.name}'s ${runs.length} tests started — ` +
            `wait for a run to finish, then try again.`
        );
      }
      setBatch({
        kind,
        name: group.name,
        total: runs.length,
        queued: started.filter((r) => r.status === 'queued').length,
        rejected: rejected.length,
      });
      setRunId(started[0].runId);
      openSocket(started[0].runId);
    } catch (err) {
      // A batch is refused whole rather than partial-accepted (entitlement
      // doesn't vary between the members of a suite), so it arrives here.
      if (err.status === 402) return needsSubscription(err);
      setError(`Run ${kind}: ${err.message}`);
      setStatus('error');
    }
  }

  function openSocket(id) {
    if (wsRef.current) wsRef.current.close();
    setWsState('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/ws?runId=${id}&token=${encodeURIComponent(token)}`
    );
    ws.onopen = () => setWsState('live');
    ws.onclose = () => setWsState('closed');
    ws.onerror = () => {
      setWsState('error');
      setError('WebSocket could not connect — check the token and that the server is reachable.');
    };
    ws.onmessage = (m) => {
      try {
        handleEvent(JSON.parse(m.data));
      } catch {
        /* ignore malformed */
      }
    };
    wsRef.current = ws;
  }

  // US-047. Optimistic on purpose: the intent is marked before the server
  // answers, because the point of the button is to stop spending and the
  // feedback has to be immediate. The server's `stopping` broadcast says the
  // same thing a moment later, and the run's own `end` decides the status.
  // A 409 means it finished on its own between the click and the request —
  // nothing went wrong, so it gets no error banner.
  async function stopRun() {
    if (!runId) return;
    markStopping();
    try {
      await api(`/api/runs/${runId}/stop`, { token, method: 'POST' });
    } catch (err) {
      if (err.status === 409) return;
      markStopping(false);
      setError(`Stop: ${err.message}`);
    }
  }

  async function downloadReport() {
    if (!runId) return;
    setReportBusy(true);
    try {
      await openReport(runId, token);
    } catch (err) {
      setError(`Report: ${err.message}`);
    } finally {
      setReportBusy(false);
    }
  }

  const running = status === 'running' || status === 'queued';
  const queued = status === 'queued' && !!waiting;
  const waitingForFirstFrame = running && !queued && !screenshot;
  const liveUrl = [...steps].reverse().find((s) => s.url)?.url || startUrl;
  const hasFrame = (showRecording && runId) || !!screenshot;
  const isDemo = health?.auth_mode === 'demo';
  // US-047: a stopped run has no verdict, whatever the `done` event claims.
  const stopped = status === 'cancelled';
  const verdict = stopped ? null : result?.success ?? null;
  const verdictTone = stopped ? 'stopped' : verdict ? 'ok' : verdict === false ? 'bad' : '';

  return (
    <>
      <PageHeader
        title="Run"
        description="Give the agent a URL and a goal in plain English, then watch it drive a real browser."
      >
        {health?.db && (
          <Button icon={Plus} onClick={newTest} disabled={needsToken}>New test</Button>
        )}
        {/* The stage shows this run; /runs/<id> is everything else about it —
            the steps, the evidence, the report. It appears as soon as the run
            has an id, not once it ends: the address is what you send to someone
            else while it is still going. Navigating there keeps the run alive,
            because the Run view hides rather than unmounts (see App). */}
        {runId && (
          <Button as={Link} icon={ExternalLink} to={`/runs/${runId}`}>Full report</Button>
        )}
        {/* US-047. `danger` colours the click, not the outcome: this interrupts
            something, and while a run is healthy it is the only red on the page,
            which is what makes it findable at the moment you want it. The record
            a stop leaves stays neutral — that is where "a stop is not a failure"
            has to hold. */}
        {running && (
          <Button variant="danger" icon={CircleStop} onClick={stopRun} disabled={stopping}>
            {stopping ? 'Stopping…' : 'Stop run'}
          </Button>
        )}
        <Button
          variant="primary"
          icon={Play}
          onClick={() => setDialog('run')}
          disabled={running || needsToken}
        >
          {queued ? 'Queued…' : running ? 'Running…' : 'New run'}
        </Button>
      </PageHeader>

      {needsToken && (
        <div className="banner page-error">
          <KeyRound size={14} aria-hidden="true" />
          <span>
            <strong>API token needed</strong>
            <span>This worker requires a token before it will accept runs.</span>
          </span>
          <Button size="sm" className="spacer" onClick={onOpenSettings}>Add token</Button>
        </div>
      )}

      {/* Readiness is per-user (US-039): runs are funded by your stored key.
          keyStatus is null until App has actually asked, so this never flashes
          before the answer — and never shows in demo mode, which runs no agent. */}
      {keyStatus && !keyStatus.set && !isDemo && (
        <div className="banner page-error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            <strong>Setup needed</strong>
            <span>No OpenAI key stored — runs will be rejected until you add yours.</span>
          </span>
          <Button size="sm" className="spacer" onClick={onOpenSettings}>Add key</Button>
        </div>
      )}

      {error && (
        <div className="error page-error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {capNotice && (
        <div className="banner page-error">
          <Clock size={14} aria-hidden="true" />
          <span>{capNotice}</span>
        </div>
      )}

      {subscribed && (
        // Informational, not celebratory: the subscription becomes real when
        // the webhook lands, which is usually immediate but is not guaranteed
        // to have happened by the time Stripe redirects the browser back.
        <div className="batch-note page-error">
          <CreditCard size={14} aria-hidden="true" />
          <span>
            Payment complete. Stripe confirms in the background — if a run is still refused, give
            it a moment and try again.
          </span>
        </div>
      )}

      {billingNotice && (
        <div className="banner page-error">
          <CreditCard size={14} aria-hidden="true" />
          <span>
            <strong>{billingNotice.status ? 'Subscription lapsed' : 'Subscription needed'}</strong>
            <span>{billingNotice.message}</span>
          </span>
          <Button size="sm" className="spacer" onClick={subscribe}>
            {billingNotice.status ? 'Resubscribe' : 'Subscribe'}
          </Button>
        </div>
      )}

      <div className={`run-grid${health?.db ? (railOpen ? '' : ' rail-min') : ' solo'}`}>
        {health?.db && !railOpen && (
          <button
            type="button"
            className="rail-strip"
            title="Show tests"
            onClick={() => toggleRail(true)}
          >
            <PanelLeftOpen size={14} aria-hidden="true" />
            <span>Tests</span>
          </button>
        )}

        {health?.db && railOpen && (
          // The wrapper is the rail's measuring stick, not decoration: it is
          // what lets the stage decide how tall the rail is. See `.rail-col`.
          <div className="rail-col">
            <aside className="card rail">
              <SavedTests
                tests={tests}
                projects={projects}
                modules={listModules}
                suites={suites}
                filter={filter}
                setFilter={setFilter}
                activeTestId={activeTestId}
                running={running}
                onRun={onRunTest}
                onEdit={editTest}
                onNew={newTest}
                onRunModule={(m, n) => runBatch('module', m, n)}
                onRunSuite={(s) => runBatch('suite', s, s.test_ids.length)}
                onCollapse={() => toggleRail(false)}
              />
            </aside>
          </div>
        )}

        <section className="stage">
          {batch && (
            <div className="batch-note">
              <Play size={14} aria-hidden="true" />
              <span>
                Running {batch.kind} <strong>{batch.name}</strong> — {batchSummary(batch)}
              </span>
            </div>
          )}

          {/* Browser left, activity right — the two things you watch during a
              run stay in one glance. Each column keeps its own height; the
              split is permanent so nothing reflows the moment the first step
              lands. */}
          <div className="stage-split">
            <div className="stage-main">
              <div className="browser">
                <div className="browser-bar">
                  <span className="browser-dots"><i /><i /><i /></span>
                  <span className="browser-url">{showRecording ? 'Session recording' : liveUrl}</span>
                </div>
                {/* With no frame to measure the box has no height of its own, so
                    the empty and starting-up states hold the capture's ratio —
                    otherwise first load is a short band under a full-width bar,
                    and the stage jumps taller the moment a frame lands. */}
                <div className={`screen${hasFrame ? '' : ' screen-empty'}`}>
                  {showRecording && runId ? (
                    // Plain <video src>, not a fetched blob: the endpoint takes
                    // a query token and honours Range, so seeking works (US-006).
                    <video
                      key={runId}
                      src={`/api/runs/${runId}/recording${token ? `?token=${encodeURIComponent(token)}` : ''}`}
                      // While a demo run is still "playing out", the recording is
                      // standing in for a live browser feed — scrubbing/pausing
                      // would give the game away (and let you skip to the verdict),
                      // so no controls until it reaches terminal.
                      controls={!(isDemo && running)}
                      autoPlay
                      onError={() => setError('Recording could not be loaded.')}
                    />
                  ) : screenshot ? (
                    <img src={screenshot} alt="live browser view" />
                  ) : queued ? (
                    <div className="thinking">
                      <div className="spinner" />
                      <div>
                        {waiting.position === 0
                          ? 'Queued — next up'
                          : `Queued — ${waiting.position} run${waiting.position === 1 ? '' : 's'} ahead of you`}
                      </div>
                      <small>
                        This worker runs {waiting.concurrency} at a time; yours starts when a slot
                        frees.
                      </small>
                    </div>
                  ) : waitingForFirstFrame ? (
                    <div className="thinking">
                      <div className="spinner" />
                      <div>Agent is starting…</div>
                      <small>First frame appears after the first action (~10–15s)</small>
                    </div>
                  ) : (
                    <EmptyState
                      icon={Monitor}
                      title="Nothing running yet"
                      action={
                        <Button variant="primary" icon={Play} onClick={() => setDialog('run')} disabled={needsToken}>
                          New run
                        </Button>
                      }
                    >
                      Start a run and the browser session streams here, frame by frame.
                    </EmptyState>
                  )}
                </div>
              </div>

              {showRecording && (
                <p className="replay-note">
                  Condensed replay — frames are only captured when the page repaints, so idle time
                  is skipped.
                </p>
              )}

              {currentAction && (
                <div className="action-bar">
                  <span className="pulse" /> {currentAction}
                </div>
              )}

              {/* A run stopped before it started has no result to show, and
                  saying nothing would leave the stage looking as though the
                  click did nothing — so the card also stands in for that. */}
              {(result || stopped) && (
                <div className={`card verdict ${verdictTone}`}>
                  <div className="verdict-head">
                    {stopped ? <CircleStop size={15} /> : verdict ? <Check size={15} /> : verdict === false ? <X size={15} /> : null}
                    {stopped ? 'Stopped' : verdict ? 'Passed' : verdict === false ? 'Failed' : 'Done'}
                  </div>
                  <div className="stats">
                    <Stat label="Verdict" value={verdict ? 'Pass' : verdict === false ? 'Fail' : '—'}
                      tone={verdict ? 'ok' : verdict === false ? 'bad' : ''} />
                    <Stat label="Steps" value={result?.steps ?? '—'} />
                    <Stat
                      label="Duration"
                      value={result?.duration_seconds ? `${Math.round(result.duration_seconds)}s` : '—'}
                    />
                  </div>
                  {stopped && (
                    <p className="hint">
                      {result
                        ? 'You stopped this run, so it reached no verdict. The steps it did take are in the report and the recording.'
                        : 'You stopped this run before it got a slot, so it never started.'}
                    </p>
                  )}
                  {result?.final_result && <p className="final">{result.final_result}</p>}
                  {result?.errors?.length > 0 && (
                    <ul className="errs">{result.errors.map((er, i) => <li key={i}>{er}</li>)}</ul>
                  )}
                  {result && (
                    <div className="verdict-actions">
                      <Button icon={Download} onClick={downloadReport} disabled={reportBusy}>
                        {reportBusy ? 'Preparing PDF…' : 'PDF report'}
                      </Button>
                      {hasRecording && !isDemo && (
                        <Button
                          icon={showRecording ? Undo2 : Play}
                          onClick={() => setShowRecording((v) => !v)}
                        >
                          {showRecording ? 'Back to last frame' : 'Watch recording'}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <aside className="card stage-side">
              <CardHead title="Activity" count={steps.length || undefined} />
              {steps.length > 0 ? (
                <ActivityLog steps={steps} logRef={logRef} />
              ) : (
                <EmptyState icon={Activity} title={running ? 'Waiting…' : 'No activity'}>
                  {queued
                    ? 'Steps start arriving once the run gets a slot.'
                    : running
                      ? 'The first step lands shortly.'
                      : 'Steps appear here during a run.'}
                </EmptyState>
              )}
            </aside>
          </div>
        </section>
      </div>

      {dialog && dialog !== 'vars' && (
        <TestDialog
          mode={dialog}
          goal={goal}
          setGoal={setGoal}
          startUrl={startUrl}
          setStartUrl={setStartUrl}
          editing={editing}
          setEditing={setEditing}
          variables={variables}
          setVariables={setVariables}
          projects={projects}
          modules={editModules}
          sessions={editSessions}
          hasDb={!!health?.db}
          saving={savingTest}
          onClose={closeDialog}
          onRun={startRun}
          onSave={saveTest}
          onDelete={deleteTest}
          onSwitchToSave={() => {
            setEditing({ name: '', project_id: filterProjectId, module_id: null });
            setVariables([]);
            setDialog('create');
          }}
        />
      )}

      {dialog === 'vars' && runVars && (
        <RunVarsDialog
          test={runVars}
          values={varValues}
          setValues={setVarValues}
          onClose={closeDialog}
          onRun={() => runSavedTest(runVars, varValues)}
        />
      )}
    </>
  );
}
