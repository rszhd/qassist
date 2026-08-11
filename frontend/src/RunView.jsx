import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, Check, CircleStop, Clock, CreditCard, Download, ExternalLink, KeyRound,
  FileText, Monitor, PanelLeftOpen, Play, Plus, X,
} from 'lucide-react';
import { api, openReport } from './api.js';
import ActivityLog from './Activity.jsx';
import { startCheckout } from './Billing.jsx';
import GoalBlock from './GoalBlock.jsx';
import SavedTests from './SavedTests.jsx';
import { MemoryPromptDialog, TestDialog, RunVarsDialog } from './RunDialogs.jsx';
import { HintBox, PauseButton } from './Steering.jsx';
import { batchSummary, fillTemplate, referencedNames, useProjectList } from './runHelpers.js';
import { useRun } from './useRun.js';
import { Button, CardHead, EmptyState, PageHeader, Stat } from './ui.jsx';

// The default view: the live stage is the page, with the saved-test rail
// beside it. Creating and editing tests happens in a dialog so the run form
// never competes with the thing you are actually here to watch.
//
// The run itself — its state, its relay events and its socket — is `useRun`.
// What is left here is the layout, the dialogs, and the saved-test lists.
export default function RunView({ token, health, keyStatus, visible, needsToken, onOpenSettings, onRunState }) {
  const run = useRun(token);
  const [goal, setGoal] = useState('Verify the page loads and find the main heading text');
  const [startUrl, setStartUrl] = useState('https://news.ycombinator.com');
  const [tests, setTests] = useState([]);
  const [projects, setProjects] = useState([]);
  // 'all' | 'none' (Ungrouped) | a project id. Drives the ?project_id= filter.
  const [filter, setFilter] = useState('all');
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
  // A test clicked in the rail and loaded into the stage without being run, so
  // what a test does can be read before it costs a run. Null once a run starts:
  // from then on `run.activeTestId` is the subject and the card is about the
  // run, which is the one thing this must not be allowed to contradict.
  const [loaded, setLoaded] = useState(null);
  // US-081: `{ testId, lessons }` while an edit is offering to clear a notebook.
  // Its own state rather than a `dialog` mode, because it opens *after* the edit
  // dialog has closed and the edit is already saved — nothing about it can fail
  // the save, and nothing about the notebook has changed yet.
  const [memoryPrompt, setMemoryPrompt] = useState(null);
  // How many lessons the test on the stage remembers, or null while unknown —
  // which covers a test with no notebook and a read that failed alike, because
  // the row says nothing in either case.
  const [memoryCount, setMemoryCount] = useState(null);
  const [reportBusy, setReportBusy] = useState(false);
  // The rail opens with the view — the tests are how a run starts, so hiding
  // them behind a strip taxes the common path. What used to make that expensive
  // was the frame shrinking to 728px to pay for it; `--stage-min` holds the
  // frame at 800 now, so the column is affordable and minimizing it is a choice
  // rather than a workaround. Remembered, but written only by `toggleRail`: a
  // `min` persisted on mount is not a preference, and storing one is what made a
  // changed default invisible to every screen that had ever opened the view.
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('qassist_rail_state') !== 'min');
  const logRef = useRef(null);

  // Back to the newest step, which the log puts at the top.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [run.steps]);

  useEffect(() => {
    onRunState({ status: run.status, wsState: run.wsState, runId: run.runId });
  }, [run.status, run.wsState, run.runId, onRunState]);

  function toggleRail(open) {
    setRailOpen(open);
    localStorage.setItem('qassist_rail_state', open ? 'open' : 'min');
  }

  // Coming back from Stripe (US-022). Checkout's success/cancel URLs land here
  // on a full page load carrying ?billing=, so it is read once and stripped —
  // a reload should not congratulate you a second time. A cancelled checkout
  // says nothing: backing out of a payment page is not an event.
  const setSubscribed = run.setSubscribed;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('billing')) return;
    setSubscribed(params.get('billing') === 'success');
    params.delete('billing');
    const query = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
  }, [setSubscribed]);

  const filterProjectId = filter === 'all' || filter === 'none' ? null : filter;
  const setError = run.setError;

  const loadTests = useCallback(async () => {
    if (!health?.db) return;
    const query = filter === 'all' ? '' : `?project_id=${filter}`;
    try {
      const { tests: rows } = await api(`/api/tests${query}`, { token });
      setTests(rows);
    } catch (err) {
      setError(`Saved tests: ${err.message}`);
    }
  }, [health?.db, token, filter, setError]);

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
  }, [health?.db, token, setError]);

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

  async function startRun() {
    setDialog(null);
    setLoaded(null);
    run.reset();
    try {
      const { runId: id } = await api('/api/runs', {
        token,
        method: 'POST',
        body: { goal, start_url: startUrl },
      });
      run.follow(id);
    } catch (err) {
      run.startFailed(err);
    }
  }

  async function subscribe() {
    try {
      await startCheckout();
    } catch (err) {
      run.setError(err.message);
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
      run.setError(`Save: secret variable ${badSecret.name} cannot appear in the Start URL`);
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
      if (editing.id) {
        const saved = await api(`/api/tests/${editing.id}`, { token, method: 'PUT', body });
        if (saved.memory?.changed) {
          setMemoryPrompt({ testId: editing.id, lessons: saved.memory.lessons });
        }
      } else {
        await api('/api/tests', { token, method: 'POST', body });
      }
      // The edited row is about to be refetched, and what is held here is the
      // version before the edit — including the name the card is printing.
      setLoaded(null);
      closeDialog();
      await loadTests();
    } catch (err) {
      run.setError(`Save: ${err.message}`);
    } finally {
      setSavingTest(false);
    }
  }

  // US-081. The edit has landed either way; this only offers to throw away what
  // the test had learned. Nothing is invalidated by an edit any more, so the
  // dialog is an offer rather than a consequence — and the default is to keep.
  async function clearMemoryAfterEdit() {
    setSavingTest(true);
    try {
      await api(`/api/tests/${memoryPrompt.testId}/memory`, { token, method: 'DELETE' });
    } catch (err) {
      run.setError(`Run memory: ${err.message}`);
    } finally {
      setMemoryPrompt(null);
      setSavingTest(false);
    }
  }

  function closeDialog() {
    setDialog(null);
    setEditing(null);
    setRunVars(null);
  }

  function editTest(test) {
    run.setError(null);
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

  // Clicking the row rather than its Run button: the same values a run would
  // resolve, put where a run's would go, and nothing started. The variables get
  // their defaults filled in, because that is what running it now would use.
  function loadTest(test) {
    run.setError(null);
    setLoaded(test);
    setGoal(fillTemplate(test.goal, test.variables));
    setStartUrl(fillTemplate(test.start_url, test.variables));
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
      if (loaded?.id === test.id) setLoaded(null);
      if (run.activeTestId === test.id) run.clearActiveTest();
      await loadTests();
    } catch (err) {
      run.setError(`Delete: ${err.message}`);
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
    setLoaded(null);
    run.reset(test.id);
    setGoal(fillTemplate(test.goal, test.variables, overrides));
    setStartUrl(fillTemplate(test.start_url, test.variables, overrides));
    try {
      const { runId: id } = await api(`/api/tests/${test.id}/run`, {
        token,
        method: 'POST',
        body: { trigger: 'ui', variables: overrides },
      });
      run.follow(id);
    } catch (err) {
      run.startFailed(err);
    }
  }

  // A module or suite run queues one run per member test. The viewer follows
  // the first; the rest run behind it at the server's concurrency limit.
  async function runBatch(kind, group, memberCount) {
    if (!memberCount) return;
    run.reset();
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
        return run.atCap(
          `You're at your run limit, so none of ${group.name}'s ${runs.length} tests started — ` +
            `wait for a run to finish, then try again.`
        );
      }
      run.setBatch({
        kind,
        name: group.name,
        total: runs.length,
        queued: started.filter((r) => r.status === 'queued').length,
        rejected: rejected.length,
      });
      run.follow(started[0].runId);
    } catch (err) {
      // A batch is refused whole rather than partial-accepted (entitlement
      // doesn't vary between the members of a suite), so it arrives here.
      run.startFailed(err, `Run ${kind}: ${err.message}`);
    }
  }

  async function downloadReport() {
    if (!run.runId) return;
    setReportBusy(true);
    try {
      await openReport(run.runId, token);
    } catch (err) {
      run.setError(`Report: ${err.message}`);
    } finally {
      setReportBusy(false);
    }
  }

  const isDemo = health?.auth_mode === 'demo';
  const { batch, queued, result, running, stopped, verdict, waiting } = run;
  const verdictTone = stopped ? 'stopped' : verdict ? 'ok' : verdict === false ? 'bad' : '';

  // What the card beside the frame is about: a test loaded off the rail, or
  // failing that the test the watched run belongs to. The numbers are the run's,
  // so they only hold while the two agree — load another test after a run and
  // they describe a test that is not the one named above them.
  const subject = loaded || tests.find((t) => t.id === run.activeTestId);
  const runIsSubject = !loaded || loaded.id === run.activeTestId;
  // With neither, there is nothing for the card beside the stage to describe:
  // the goal and URL in state are the New run dialog's draft, and three dashed
  // stats over them read as a run that was made and told nobody anything.
  const hasSubject = Boolean(subject || run.runId);

  // US-081, and the same count the edit dialog's panel opens onto. Read here
  // because the notebook is what makes two runs of one test differ, and the
  // card beside the stage is where that difference is being watched for.
  // Re-read when a run ends: a passing run is exactly when a test learns
  // something, so a stale count would be wrong at the one moment it is looked
  // at. A failed read leaves null, which reads as "no notebook" — this is one
  // line about an optimisation, not something to put an error on the stage for.
  const subjectId = subject?.id;
  useEffect(() => {
    // Cleared first, so the previous test's count is never shown under this
    // one's name while the read is in flight.
    setMemoryCount(null);
    if (!subjectId || !health?.db) return;
    let dropped = false;
    api(`/api/tests/${subjectId}/memory`, { token })
      .then(({ learned }) => {
        if (dropped) return;
        setMemoryCount(Object.values(learned || {}).reduce((n, items) => n + (items?.length || 0), 0));
      })
      .catch(() => {});
    return () => {
      dropped = true;
    };
  }, [subjectId, token, health?.db, result]);

  // Where the agent is, or where it will start. Empty with no subject: the URL
  // in state is the dialog's draft, and a bar showing it looks like a page the
  // stage under it failed to draw.
  const liveUrl = [...run.steps].reverse().find((s) => s.url)?.url || (hasSubject ? startUrl : '');

  return (
    <>
      <PageHeader title="Run">
        {health?.db && (
          <Button icon={Plus} onClick={newTest} disabled={needsToken}>New test</Button>
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
          <Button size="sm" className="spacer" onClick={() => onOpenSettings()}>Add token</Button>
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
          {/* Named field, not a bare open: this banner asks for one thing, so
              the dialog opens with the cursor already in it. */}
          <Button size="sm" className="spacer" onClick={() => onOpenSettings('openai-key')}>
            Add key
          </Button>
        </div>
      )}

      {run.error && (
        <div className="error page-error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{run.error}</span>
        </div>
      )}

      {run.capNotice && (
        <div className="banner page-error">
          <Clock size={14} aria-hidden="true" />
          <span>{run.capNotice}</span>
        </div>
      )}

      {run.subscribed && (
        // Informational, not celebratory: the subscription becomes real when
        // the webhook lands, which is usually immediate but is not guaranteed
        // to have happened by the time Stripe redirects the browser back.
        <div className="note page-error">
          <CreditCard size={14} aria-hidden="true" />
          <span>
            Payment complete. Stripe confirms in the background — if a run is still refused, give
            it a moment and try again.
          </span>
        </div>
      )}

      {run.billingNotice && (
        <div className="banner page-error">
          <CreditCard size={14} aria-hidden="true" />
          <span>
            <strong>{run.billingNotice.status ? 'Subscription lapsed' : 'Subscription needed'}</strong>
            <span>{run.billingNotice.message}</span>
          </span>
          <Button size="sm" className="spacer" onClick={subscribe}>
            {run.billingNotice.status ? 'Resubscribe' : 'Subscribe'}
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
                activeTestId={subject?.id ?? null}
                running={running}
                onRun={onRunTest}
                onEdit={editTest}
                onSelect={loadTest}
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
            <div className="note">
              <Play size={14} aria-hidden="true" />
              <span>
                Running {batch.kind} <strong>{batch.name}</strong> — {batchSummary(batch)}
              </span>
            </div>
          )}

          {/* Frame, then the activity under it at the frame's own width, with
              the run's facts and controls in the rail beside them. A step
              sentence is prose and needs a line; a verdict, a URL and a button
              are each narrow by nature — so the narrow column holds the narrow
              things. Minimizing the tests rail trades the two: a maximized
              frame is tall enough that only what is beside it is still on
              screen, so the log takes the column and the facts go under the
              frame. `.stage-split` in views.css owns the swap; the frame is
              never bounded to buy it. */}
          <div className="stage-split">
            <div className="stage-main">
              <div className="browser">
                <div className="browser-bar">
                  <span className="browser-dots"><i /><i /><i /></span>
                  {/* `showRecording` is demo-only since US-076 retired the
                      toggle: a demo replay is the stage feed, a real run is
                      always live frames here. */}
                  <span className="browser-url">{run.showRecording ? 'Session recording' : liveUrl}</span>
                </div>
                {/* With no frame to measure the box has no height of its own, so
                    the empty and starting-up states hold the capture's ratio —
                    otherwise first load is a short band under a full-width bar,
                    and the stage jumps taller the moment a frame lands. */}
                <div className={`screen${run.hasFrame ? '' : ' screen-empty'}`}>
                  {run.showRecording && run.runId ? (
                    // The demo replay standing in for a live feed — nothing
                    // else reaches this branch. A real run's recording is on
                    // /runs/<id>, which opens with the player already in it.
                    // Plain <video src>, not a fetched blob: the endpoint takes
                    // a query token and honours Range, so seeking works (US-006).
                    <video
                      key={run.runId}
                      src={`/api/runs/${run.runId}/recording${token ? `?token=${encodeURIComponent(token)}` : ''}`}
                      // While a demo run is still "playing out", the recording is
                      // standing in for a live browser feed — scrubbing/pausing
                      // would give the game away (and let you skip to the verdict),
                      // so no controls until it reaches terminal.
                      controls={!(isDemo && running)}
                      autoPlay
                      onError={() => run.setError('Recording could not be loaded.')}
                    />
                  ) : run.screenshot ? (
                    <img src={run.screenshot} alt="live browser view" />
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
                  ) : run.waitingForFirstFrame ? (
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

              {/* Demo-only, with the branch above it: it explains why the
                  replay skips ahead of itself. */}
              {run.showRecording && (
                <p className="replay-note">
                  Condensed replay — frames are only captured when the page repaints, so idle time
                  is skipped.
                </p>
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
                  {stopped && (
                    <p className="hint">
                      {result
                        ? 'You stopped this run, so it reached no verdict. The steps it did take are kept, with the recording, on the run’s own page.'
                        : 'You stopped this run before it got a slot, so it never started.'}
                    </p>
                  )}
                  {result?.final_result && <p className="final">{result.final_result}</p>}
                  {result?.errors?.length > 0 && (
                    <ul className="errs">{result.errors.map((er, i) => <li key={i}>{er}</li>)}</ul>
                  )}
                </div>
              )}
            </div>

            {/* How it went, what it was, then what it was told: the numbers
                first because they are the answer, the name and the URL under
                them because they say what the answer is about, and the
                instructions last because they are the only part that runs long.
                The buttons are not here: they went to the Activity card, next
                to the list that prompts them. Each part waits for something to
                say — the numbers for a finished run, the rest for a test — and
                with nothing loaded and nothing run the card says it is empty. */}
            <aside className="card stage-side">
              {hasSubject ? (
                <>
                  {/* Only once there is an answer to give. A running verdict is
                      a dash by definition, and the log beside it is already
                      counting the steps — three empty numbers over the test's
                      name only take the space the name reads in. A stop still
                      lands here: it has no verdict, but the count and the
                      seconds it did spend are the record of it. */}
                  {runIsSubject && result && (
                    <div className="stats">
                      <Stat
                        label="Verdict"
                        value={verdict ? 'Pass' : verdict === false ? 'Fail' : '—'}
                        tone={verdict ? 'ok' : verdict === false ? 'bad' : ''}
                      />
                      <Stat label="Steps" value={result.steps ?? run.steps.length} />
                      <Stat
                        label="Duration"
                        value={result.duration_seconds ? `${Math.round(result.duration_seconds)}s` : '—'}
                      />
                    </div>
                  )}

                  {/* One list, so every label sits the same distance under the
                      one above it. The instructions used to be a block of their
                      own beside it, which put a rule and a card gap between two
                      rows that are the same kind of fact — and read as two lists
                      that had lost their alignment. */}
                  <dl className="detail-facts">
                    <dt>Name</dt>
                    <dd>{subject?.name || 'Ad-hoc run'}</dd>
                    <dt>Start URL</dt>
                    <dd title={startUrl}>{startUrl}</dd>
                    {/* What is running, which the stage never showed before: the
                        frame's URL bar follows the agent, so after the first
                        navigation nothing on the page said what the run was
                        asked to do. Keyed on the text: loading another test off
                        the rail replaces the paragraph, and it should arrive
                        folded. The `dt` is its heading, so it renders without
                        one of its own. */}
                    <dt>Instructions</dt>
                    <dd className="detail-instructions">
                      <GoalBlock goal={goal} resetKey={goal} heading={false} />
                    </dd>
                    {/* The names the goal and the URL above are written against,
                        so a reader can see what `{{host}}` stood for rather than
                        only the text it resolved to. These are the test's own
                        declarations, not one run's overrides — the resolved set
                        a given run actually used is on /runs/<id>. A secret has
                        no value to show by design (US-064). Absent when the test
                        declares none, which is most of them. */}
                    {subject?.variables?.length > 0 && (
                      <>
                        <dt>Variables</dt>
                        <dd className="detail-vars">
                          {subject.variables.map((v) => (
                            <span className="var-chip" key={v.name}>
                              <b>{v.name}</b>
                              {v.secret ? ' (secret)' : v.value ? `=${v.value}` : ' (empty)'}
                            </span>
                          ))}
                        </dd>
                      </>
                    )}
                    {/* Absent at zero, like the edit dialog's panel: a test that
                        has learned nothing is every new test, and a permanent
                        "Memory 0" makes an automatic thing look like a setting
                        nobody filled in. The lessons themselves are in the edit
                        dialog — this only says there are some. */}
                    {memoryCount > 0 && (
                      <>
                        <dt>Memory</dt>
                        <dd>{memoryCount === 1 ? '1 lesson' : `${memoryCount} lessons`}</dd>
                      </>
                    )}
                  </dl>
                </>
              ) : (
                /* No "New run" button here — the stage beside this card already
                   offers it, and one empty card should not answer another. */
                <EmptyState icon={FileText} title="No test selected">
                  Pick a saved test or start a run, and what it was told appears here.
                </EmptyState>
              )}
            </aside>

            <aside className="card stage-log">
              {/* The buttons sit with the log because that is where the run is
                  watched from: Stop is reached for while reading the step that
                  made you want it, and the two reports answer the last row of
                  the same list. In the head and pushed to its right end, like
                  the tests rail's own, so the card's controls stay on one line
                  whatever the list under them is doing. Full-height buttons, so
                  they read as the same control they were in the page header —
                  the head grows from `--ctl-sm` to `--ctl` to hold them. */}
              <CardHead title="Activity" count={run.steps.length || undefined}>
                {(running || result) && (
                  <div className="verdict-actions spacer">
                    {/* US-047. `danger` colours the click, not the outcome: this
                        interrupts something, and while a run is healthy it is
                        the only red on the page, which is what makes it findable
                        at the moment you want it. The record a stop leaves stays
                        neutral — that is where "a stop is not a failure" holds.
                        US-079's pause sits beside it and stays neutral for the
                        same reason from the other side: it interrupts nothing
                        and spends nothing. Only once the run actually holds a
                        slot — a queued run has no process to hold, which is what
                        the route answers 409 to. */}
                    {running && !queued && !run.stopping && (
                      <PauseButton paused={run.paused} onPause={run.pause} onResume={run.resume} />
                    )}
                    {running && (
                      <Button variant="danger" icon={CircleStop} onClick={run.stop} disabled={run.stopping}>
                        {run.stopping ? 'Stopping…' : 'Stop run'}
                      </Button>
                    )}
                    {/* REPORTS_ENABLED off means no PDF is rendered for any run
                        on this instance, so the offer goes rather than becoming
                        a download that 404s. */}
                    {result && health?.reports && (
                      <Button icon={Download} onClick={downloadReport} disabled={reportBusy}>
                        {reportBusy ? 'Preparing PDF…' : 'PDF report'}
                      </Button>
                    )}
                    {/* The stage shows the run; /runs/<id> holds everything else
                        about it — the steps, the evidence, the report.
                        Navigating there keeps this run alive: the Run view hides
                        rather than unmounts (see App). */}
                    {result && (
                      <Button as={Link} icon={ExternalLink} to={`/runs/${run.runId}`}>
                        Full report
                      </Button>
                    )}
                  </div>
                )}
              </CardHead>

              {/* The one thing a stop has to say that no step row carries: why
                  it is not instant. The button above says "Stopping…"; this says
                  what it is waiting for. No pulse — it explains a wait, it is
                  not the thing the agent is doing. */}
              {run.stopping && <p className="hint">Finishing the recording and the report…</p>}
              {/* Above the log rather than below it: the log is newest-first, so
                  what you type lands on the row directly under the box. Offered
                  while the run is merely running, not only while it is held — a
                  correction that arrives without a pause is the cheaper fix. */}
              {running && !queued && !run.stopping && (
                <HintBox
                  paused={run.paused}
                  until={run.pausedUntil}
                  onHint={run.hint}
                  onResume={run.resume}
                />
              )}
              {/* `live` puts the pulse on the newest row, which is the current
                  action while a run is going: the agent announces a step as it
                  starts it. Off here once the run ends, and never set by
                  RunDetail, where every row is history. */}
              {run.steps.length > 0 ? (
                <ActivityLog steps={run.steps} logRef={logRef} live={running} />
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
          token={token}
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

      {/* Outside the `dialog` switch: this one opens after the edit dialog has
          closed and the edit has already saved, so it is not a mode of that
          flow — it is a question about a side effect of it. */}
      {memoryPrompt && (
        <MemoryPromptDialog
          lessons={memoryPrompt.lessons}
          saving={savingTest}
          onClear={clearMemoryAfterEdit}
          onClose={() => setMemoryPrompt(null)}
        />
      )}
    </>
  );
}
