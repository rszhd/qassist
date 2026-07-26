import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, ChevronDown, ChevronUp, Download, ExternalLink, Play, Undo2 } from 'lucide-react';
import { api, openReport } from './api.js';
import ActivityLog from './Activity.jsx';
import { Button, CardHead, EmptyState, IconButton, Stat } from './ui.jsx';
import { formatWhen, formatDuration } from './status.js';

// One past run, rendered mostly from the row the history list already has.
// What it fetches: the PDF as a blob (it needs the bearer header), the
// recording as a plain <video src> with a query token, which is what makes
// seeking work (US-006), and the step list (US-026) — the run's activity is
// on disk in report_data.json, not in the history row.
//
// `liveSteps` is the run page's override (US-030): a run still in flight has
// its steps arriving over the WebSocket, and refetching them would replace a
// live list with a stale one. `permalink` is the other half — History shows
// the link out to /runs/<id>, the page itself has no reason to link to itself.
//
// Step screenshots hang off a step in that list once US-020 lands.
//
// `layout` arranges those same blocks two ways rather than letting the page
// grow a second copy of them. "panel" is the History column: one narrow stack,
// verdict first. "page" is /runs/<id>, which has the whole width and a goal
// that can be a pasted test case — so the goal and the activity take a reading
// column and the facts fall back to a rail beside it.
export default function RunDetail({ run, token, onError, liveSteps, permalink, layout = 'panel' }) {
  const [reportBusy, setReportBusy] = useState(false);
  const [showRecording, setShowRecording] = useState(false);
  // null until the fetch settles, so an empty list reads as "none recorded"
  // rather than flashing that message under every run while it loads.
  const [fetched, setFetched] = useState(null);

  const [goalOpen, setGoalOpen] = useState(false);
  const goalRef = useRef(null);
  const [goalClamped, setGoalClamped] = useState(false);

  const pruned = !!run.artifacts_deleted_at;
  const steps = liveSteps ?? fetched;
  const unfinished = run.status === 'queued' || run.status === 'running';

  // Whether the goal actually outgrows its clamp, so a goal that already fits
  // doesn't get a toggle that does nothing. Only measurable while collapsed —
  // expanded, scrollHeight and clientHeight are equal by definition, so the
  // last collapsed answer is the one worth keeping. The observer is what
  // catches a width change: the detail column narrows at the 900px breakpoint,
  // and a goal that needed four lines at 440px may need six at 320px.
  useLayoutEffect(() => {
    const el = goalRef.current;
    if (!el || goalOpen) return;
    const measure = () => setGoalClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [goalOpen, run.goal]);

  // A different run is a different goal — reopening it expanded would show the
  // new one already unfolded because the last one was.
  useEffect(() => setGoalOpen(false), [run.id]);

  // A pruned run's steps went with its artifacts — the notice below already
  // says so, so don't ask for a 404 to find that out.
  useEffect(() => {
    if (pruned || liveSteps) return;
    let current = true;
    api(`/api/runs/${run.id}/steps`, { token })
      .then((data) => current && setFetched(data.steps))
      .catch(() => current && setFetched([]));
    return () => {
      current = false;
    };
  }, [run.id, pruned, token, liveSteps]);

  async function downloadReport() {
    setReportBusy(true);
    try {
      await openReport(run.id, token);
    } catch (err) {
      onError(`Report: ${err.message}`);
    } finally {
      setReportBusy(false);
    }
  }

  const page = layout === 'page';

  const verdictHead = (
    <div className="verdict-head">
      {run.test_name || 'Ad-hoc run'}
      <span className={`badge badge-${run.status}`}>{run.status}</span>
      {permalink && (
        <IconButton
          as={Link}
          to={`/runs/${run.id}`}
          icon={ExternalLink}
          label="Open this run on its own page"
        />
      )}
    </div>
  );


  const recording = showRecording && run.has_recording && (
    <div className="browser detail-screen">
      <div className="browser-bar">
        <span className="browser-dots"><i /><i /><i /></span>
        <span className="browser-url">Session recording</span>
      </div>
      <div className="screen">
        <video
          key={run.id}
          src={`/api/runs/${run.id}/recording${token ? `?token=${encodeURIComponent(token)}` : ''}`}
          controls
          autoPlay
          onError={() => onError('Recording could not be loaded.')}
        />
      </div>
    </div>
  );

  const stats = (
    <div className="stats">
      <Stat
        label="Verdict"
        value={run.success === true ? 'Pass' : run.success === false ? 'Fail' : '—'}
        tone={run.success === true ? 'ok' : run.success === false ? 'bad' : ''}
      />
      <Stat label="Steps" value={run.steps_count ?? '—'} />
      <Stat label="Duration" value={formatDuration(run.started_at, run.finished_at)} />
    </div>
  );

  const facts = (
    <dl className="detail-facts">
      <dt>Started</dt>
      <dd>{formatWhen(run.created_at)}</dd>
      <dt>Trigger</dt>
      <dd>{run.trigger}</dd>
      <dt>URL</dt>
      <dd title={run.start_url}>{run.start_url}</dd>
      {/* US-035: the resolved non-secret variables this run used, so a
          failure is attributable to the environment it ran against. Absent
          for a run with no variables — the dl is otherwise unchanged. */}
      {run.variables && Object.keys(run.variables).length > 0 && (
        <>
          <dt>Variables</dt>
          <dd className="detail-vars">
            {Object.entries(run.variables).map(([name, value]) => (
              <span className="var-chip" key={name}>
                <b>{name}</b>
                {value ? `=${value}` : ' (empty)'}
              </span>
            ))}
          </dd>
        </>
      )}
    </dl>
  );

  // On the page the goal is the subject, so it gets a heading and leads the
  // reading column; in the panel it stays an unlabelled paragraph under the
  // facts, which is the shape History has always had.
  const goal = (
    <section className="goal-block">
      {page && <CardHead title="Goal" />}
      <p ref={goalRef} className={`detail-goal${goalOpen ? ' open' : ''}`}>{run.goal}</p>
      {goalClamped && (
        <Button
          variant="ghost"
          size="sm"
          icon={goalOpen ? ChevronUp : ChevronDown}
          aria-expanded={goalOpen}
          onClick={() => setGoalOpen((open) => !open)}
        >
          {goalOpen ? 'Show less' : 'Read more'}
        </Button>
      )}
    </section>
  );

  // "Summary" rather than "Result": it is the agent's account of what happened,
  // and the rail already answers the pass/fail question under "Verdict". The
  // PDF calls this block the summary too. The error keeps no heading — its icon
  // and colour say what it is.
  const outcome = (
    <>
      {run.final_result && (
        <section className="result-block">
          {page && <CardHead title="Summary" />}
          <p className="final">{run.final_result}</p>
        </section>
      )}
      {run.error && (
        <div className="error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{run.error}</span>
        </div>
      )}
    </>
  );

  const activity = !pruned && steps !== null && (
    <>
      <CardHead title="Activity" count={steps.length || undefined} />
      {steps.length > 0 ? (
        <ActivityLog steps={steps} />
      ) : unfinished ? (
        <EmptyState icon={Activity} title="Waiting…">
          {run.status === 'queued'
            ? 'Steps start arriving once the run gets a slot.'
            : 'The first step lands shortly.'}
        </EmptyState>
      ) : (
        <EmptyState icon={Activity} title="No activity recorded">
          This run ended before its steps were written to disk.
        </EmptyState>
      )}
    </>
  );

  const actions = pruned ? (
    <p className="hint">
      Artifacts were removed on {formatWhen(run.artifacts_deleted_at)} — the report and
      recording are gone, the verdict above is kept.
    </p>
  ) : (
    <div className="verdict-actions">
      <Button
        icon={Download}
        onClick={downloadReport}
        disabled={reportBusy || run.report_status === 'none'}
        title={
          run.report_status !== 'none'
            ? undefined
            : unfinished
              ? 'The report is rendered when the run finishes'
              : 'No report for this run'
        }
      >
        {reportBusy ? 'Preparing PDF…' : 'PDF report'}
      </Button>
      {run.has_recording && (
        <Button icon={showRecording ? Undo2 : Play} onClick={() => setShowRecording((v) => !v)}>
          {showRecording ? 'Hide recording' : 'Watch recording'}
        </Button>
      )}
    </div>
  );

  // The page drops `verdictHead`: RunPage's own header already names the run
  // and carries its status, so repeating it here printed the title twice.
  // The recording spans both columns — it is 16:9 and the rail's width would
  // waste it — and everything narrow enough to read as a fact goes to the rail.
  if (page) {
    return (
      <div className="run-detail-page">
        <section className="card detail-main">
          {recording}
          {goal}
          {outcome}
          {activity}
        </section>
        <aside className="card detail-side">
          {stats}
          {facts}
          {actions}
        </aside>
      </div>
    );
  }

  return (
    <div className="run-detail">
      {verdictHead}
      {recording}
      {stats}
      {facts}
      {goal}
      {outcome}
      {/* Direct children of `.run-detail`, so the header and the list take the
          card's own gap — the same rhythm the live panel reads at. */}
      {activity}
      {actions}
    </div>
  );
}
