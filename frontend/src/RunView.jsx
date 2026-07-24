import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, Check, Download, KeyRound, Monitor, PanelLeftOpen, Play, Plus,
  Trash2, Undo2, X,
} from 'lucide-react';
import { api, openReport } from './api.js';
import ActivityLog from './Activity.jsx';
import SavedTests from './SavedTests.jsx';
import { Button, CardHead, EmptyState, Field, IconButton, Modal, PageHeader, Stat } from './ui.jsx';

// The default view: the live stage is the page, with the saved-test rail
// beside it. Creating and editing tests happens in a dialog so the run form
// never competes with the thing you are actually here to watch.
//
// Owns everything about a single run (WS socket, steps, result, report).
export default function RunView({ token, health, visible, needsToken, onOpenSettings, onRunState }) {
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
  // The rail is a launcher, not something you read mid-run — minimizing it to
  // a strip hands its 300px to the live view. Remembered, since it is a
  // per-screen preference rather than a per-run one.
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('qassist_rail') !== 'min');
  // US-006: set by the `recording` event that arrives just before the run
  // ends. `showRecording` swaps the live screen for the replay player.
  const [hasRecording, setHasRecording] = useState(false);
  const [showRecording, setShowRecording] = useState(false);
  const wsRef = useRef(null);
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [steps]);

  useEffect(() => {
    onRunState({ status, wsState, runId });
  }, [status, wsState, runId, onRunState]);

  useEffect(() => {
    localStorage.setItem('qassist_rail', railOpen ? 'open' : 'min');
  }, [railOpen]);

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
      case 'recording':
        // Emitted before done/error, so the button is ready when the run ends.
        setHasRecording(true);
        break;
      case 'done':
        setResult(evt);
        setCurrentAction(null);
        setStatus(evt.success === true ? 'passed' : evt.success === false ? 'failed' : 'completed');
        break;
      case 'error':
        setError(evt.message);
        setCurrentAction(null);
        setStatus('error');
        break;
      case 'end':
        setCurrentAction(null);
        setWaiting(null);
        setStatus((cur) => (cur === 'running' || cur === 'queued' ? evt.status : cur));
        break;
      default:
        break;
    }
  }

  function resetRunState() {
    setError(null);
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
      setError(err.message);
      setStatus('error');
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
      setBatch({
        kind,
        name: group.name,
        total: runs.length,
        queued: runs.filter((r) => r.status === 'queued').length,
      });
      setRunId(runs[0].runId);
      openSocket(runs[0].runId);
    } catch (err) {
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

  return (
    <>
      <PageHeader
        title="Run"
        description="Give the agent a URL and a goal in plain English, then watch it drive a real browser."
      >
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
          <Button size="sm" className="spacer" onClick={onOpenSettings}>Add token</Button>
        </div>
      )}

      {health && !health.agent_ready && (
        <div className="banner page-error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            <strong>Setup needed</strong>
            <span>
              No <code>OPENAI_API_KEY</code> on the server — runs will be rejected. Add it to{' '}
              <code>.env</code> and restart.
            </span>
          </span>
        </div>
      )}

      {error && (
        <div className="error page-error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className={`run-grid${health?.db ? (railOpen ? '' : ' rail-min') : ' solo'}`}>
        {health?.db && !railOpen && (
          <button
            type="button"
            className="rail-strip"
            title="Show tests"
            onClick={() => setRailOpen(true)}
          >
            <PanelLeftOpen size={14} aria-hidden="true" />
            <span>Tests</span>
          </button>
        )}

        {health?.db && railOpen && (
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
              onCollapse={() => setRailOpen(false)}
            />
          </aside>
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
                      controls
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

              {result && (
                <div className={`card verdict ${result.success ? 'ok' : result.success === false ? 'bad' : ''}`}>
                  <div className="verdict-head">
                    {result.success ? <Check size={15} /> : result.success === false ? <X size={15} /> : null}
                    {result.success ? 'Passed' : result.success === false ? 'Failed' : 'Done'}
                  </div>
                  <div className="stats">
                    <Stat label="Verdict" value={result.success ? 'Pass' : result.success === false ? 'Fail' : '—'}
                      tone={result.success ? 'ok' : result.success === false ? 'bad' : ''} />
                    <Stat label="Steps" value={result.steps ?? '—'} />
                    <Stat
                      label="Duration"
                      value={result.duration_seconds ? `${Math.round(result.duration_seconds)}s` : '—'}
                    />
                  </div>
                  {result.final_result && <p className="final">{result.final_result}</p>}
                  {result.errors?.length > 0 && (
                    <ul className="errs">{result.errors.map((er, i) => <li key={i}>{er}</li>)}</ul>
                  )}
                  <div className="verdict-actions">
                    <Button icon={Download} onClick={downloadReport} disabled={reportBusy}>
                      {reportBusy ? 'Preparing PDF…' : 'PDF report'}
                    </Button>
                    {hasRecording && (
                      <Button
                        icon={showRecording ? Undo2 : Play}
                        onClick={() => setShowRecording((v) => !v)}
                      >
                        {showRecording ? 'Back to last frame' : 'Watch recording'}
                      </Button>
                    )}
                  </div>
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

// Same identifier grammar the server matches on (server/src/variables.js).
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** The distinct `{{name}}` names a text references. */
function referencedNames(text) {
  return new Set([...String(text ?? '').matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
}

/**
 * Fill a saved test's `{{name}}` placeholders for the stage display only — the
 * server does the authoritative substitution. Overrides win over each
 * variable's default; an unknown name is left as-is (the server would 400 it).
 * A secret is shown as the `<secret>name</secret>` placeholder, never its value
 * — the same masking the server applies, so a password never lands in the goal
 * textarea (US-035 secret path).
 */
function fillTemplate(text, variables, overrides) {
  const values = {};
  const secret = new Set();
  for (const v of variables || []) {
    values[v.name] = v.value;
    if (v.secret) secret.add(v.name);
  }
  if (overrides) Object.assign(values, overrides);
  return String(text ?? '').replace(PLACEHOLDER_RE, (whole, name) => {
    if (secret.has(name)) return `<secret>${name}</secret>`;
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole;
  });
}

/**
 * What a module or suite run actually did with its tests. The server starts as
 * many as the concurrency cap allows and queues the rest, so on a busy worker
 * "the rest run in the background" is only half the truth (US-027).
 */
function batchSummary({ total, queued }) {
  const tests = `${total} test${total === 1 ? '' : 's'}`;
  if (total === 1) return `${tests}, running below.`;
  if (queued > 0) return `${tests}. Following the first below; ${queued} wait for a free slot.`;
  return `${tests}. Following the first below; the rest run in the background.`;
}

/**
 * The one place a run is described. `run` mode fires an ad-hoc run and can
 * hand its values over to `create`; `create`/`edit` write a saved test. The
 * URL and goal are the caller's state either way, so whatever you typed here
 * is what the stage shows while the run happens.
 */
function TestDialog({
  mode, goal, setGoal, startUrl, setStartUrl, editing, setEditing, variables, setVariables,
  projects, modules, hasDb, saving, onClose, onRun, onSave, onDelete, onSwitchToSave,
}) {
  const isRun = mode === 'run';
  const ready = startUrl.trim() && goal.trim() && (isRun || editing?.name.trim());
  const submit = (e) => {
    e.preventDefault();
    if (ready) (isRun ? onRun : onSave)();
  };

  return (
    <Modal
      title={isRun ? 'New run' : mode === 'edit' ? 'Edit test' : 'New test'}
      description={
        isRun
          ? 'Runs once, right now. Nothing is saved unless you ask for it.'
          : 'Saved tests re-run with one click and keep their history.'
      }
      onClose={onClose}
      footer={
        <>
          {mode === 'edit' && (
            <Button variant="danger" icon={Trash2} onClick={() => onDelete(editing)}>
              Delete
            </Button>
          )}
          {isRun && hasDb && (
            <Button variant="ghost" icon={Plus} onClick={onSwitchToSave} disabled={!ready}>
              Save as test
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={isRun ? Play : undefined}
            onClick={submit}
            disabled={!ready || saving}
          >
            {isRun ? 'Run test' : saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Save test'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="modal-form">
        {!isRun && (
          <Field label="Name">
            <input
              value={editing.name}
              autoFocus
              placeholder="Checkout flow works"
              onChange={(e) => setEditing((cur) => ({ ...cur, name: e.target.value }))}
            />
          </Field>
        )}

        {!isRun && projects.length > 0 && (
          <div className="field-row">
            <Field label="Project">
              <select
                value={editing.project_id || ''}
                onChange={(e) =>
                  // Changing project invalidates the module choice.
                  setEditing((cur) => ({ ...cur, project_id: e.target.value || null, module_id: null }))
                }
              >
                <option value="">Ungrouped</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            {modules.length > 0 && (
              <Field label="Module">
                <select
                  value={editing.module_id || ''}
                  onChange={(e) => setEditing((cur) => ({ ...cur, module_id: e.target.value || null }))}
                >
                  <option value="">No module</option>
                  {modules.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        )}

        <Field label="Start URL">
          <input value={startUrl} autoFocus={isRun} onChange={(e) => setStartUrl(e.target.value)} />
        </Field>

        <Field
          label="Goal"
          hint="Some sites (Reddit, Cloudflare-protected pages) block datacenter IPs and will fail from a server."
        >
          <textarea rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>

        {!isRun && <VariablesEditor variables={variables} setVariables={setVariables} />}

        {/* Enter in a text field submits the dialog. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/**
 * Declare a saved test's variables (US-035). Kept out of the way for the basic
 * case: with none declared it is a single quiet "Add variable" button, so a
 * test that needs no variables looks exactly like the pre-US-035 dialog. Each
 * variable is a name and a default value; the goal/URL reference it as
 * `{{name}}` and a run can override it. A **secret** carries no stored default
 * (its value arrives per run or from CI, never persisted); an **optional** one
 * may resolve empty.
 */
function VariablesEditor({ variables, setVariables }) {
  const set = (i, changes) =>
    setVariables((cur) => cur.map((v, j) => (j === i ? { ...v, ...changes } : v)));
  const add = () => setVariables((cur) => [...cur, { name: '', value: '', secret: false, optional: false }]);
  const remove = (i) => setVariables((cur) => cur.filter((_, j) => j !== i));

  return (
    <div className="vars">
      {variables.length > 0 && (
        <>
          <span className="field-label">Variables</span>
          <p className="field-hint">
            Reference them in the goal or Start URL as <code>{'{{name}}'}</code>. Each run can
            override the default. A <b>secret</b> is never stored or shown — its value is set per
            run or by CI; an <b>optional</b> one may resolve empty.
          </p>
          {variables.map((v, i) => (
            <div className="var-row" key={i}>
              <div className="var-main">
                <input
                  className="var-name"
                  value={v.name}
                  placeholder="name"
                  aria-label={`Variable ${i + 1} name`}
                  onChange={(e) => set(i, { name: e.target.value })}
                />
                {v.secret ? (
                  <span className="var-note">value set per run / CI</span>
                ) : (
                  <input
                    value={v.value}
                    placeholder="default value"
                    aria-label={`Variable ${i + 1} default value`}
                    onChange={(e) => set(i, { value: e.target.value })}
                  />
                )}
                <IconButton icon={Trash2} variant="danger" label="Remove variable" onClick={() => remove(i)} />
              </div>
              <div className="var-flags">
                <label className="var-flag">
                  <input
                    type="checkbox"
                    checked={v.secret}
                    // A secret carries no stored default — clear it on toggle so no
                    // plaintext secret lands in tests.variables (US-035 secret path).
                    onChange={(e) => set(i, e.target.checked ? { secret: true, value: '' } : { secret: false })}
                  />
                  Secret
                </label>
                <label className="var-flag">
                  <input
                    type="checkbox"
                    checked={v.optional}
                    onChange={(e) => set(i, { optional: e.target.checked })}
                  />
                  Optional
                </label>
              </div>
            </div>
          ))}
        </>
      )}
      <Button size="sm" variant="ghost" icon={Plus} onClick={add} className="var-add">
        Add variable
      </Button>
    </div>
  );
}

/**
 * Override a variable'd test's values for this one run (US-035), prefilled with
 * each default. Only opens for a test that declares variables — the one-click
 * run path is untouched for everything else.
 */
function RunVarsDialog({ test, values, setValues, onClose, onRun }) {
  const submit = (e) => {
    e.preventDefault();
    onRun();
  };
  return (
    <Modal
      title={`Run ${test.name}`}
      description="Set this run's variables, then run. Defaults are prefilled — a blank field runs empty."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Play} onClick={submit}>Run test</Button>
        </>
      }
    >
      <form onSubmit={submit} className="modal-form">
        {test.variables.map((v) => (
          <Field
            key={v.name}
            label={v.name}
            hint={v.secret ? 'Secret — never stored or shown after this run.' : undefined}
          >
            <input
              type={v.secret ? 'password' : 'text'}
              value={values[v.name] ?? ''}
              onChange={(e) => setValues((cur) => ({ ...cur, [v.name]: e.target.value }))}
            />
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/**
 * Rows from `url` (null = nothing to fetch), unwrapped from `res[key]` and
 * refetched whenever the url or `tick` changes. Deliberately uncached: these
 * lists are small, and refetching is what keeps the Run view in step with
 * edits made in Projects.
 */
function useProjectList(url, key, token, onError, tick) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!url) {
      setRows([]);
      return;
    }
    let cancelled = false;
    api(url, { token })
      .then((res) => !cancelled && setRows(res[key]))
      .catch((err) => !cancelled && onError(`${key}: ${err.message}`));
    return () => {
      cancelled = true;
    };
  }, [url, key, token, onError, tick]);
  return rows;
}
