import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Download, Play, Undo2 } from 'lucide-react';
import { api, openReport } from './api.js';
import ActivityLog from './Activity.jsx';
import { Button, CardHead, EmptyState, Stat } from './ui.jsx';
import { formatWhen, formatDuration } from './status.js';

// One past run, rendered mostly from the row the history list already has.
// What it fetches: the PDF as a blob (it needs the bearer header), the
// recording as a plain <video src> with a query token, which is what makes
// seeking work (US-006), and the step list (US-026) — the run's activity is
// on disk in report_data.json, not in the history row.
//
// Step screenshots hang off a step in that list once US-020 lands.
export default function RunDetail({ run, token, onError }) {
  const [reportBusy, setReportBusy] = useState(false);
  const [showRecording, setShowRecording] = useState(false);
  // null until the fetch settles, so an empty list reads as "none recorded"
  // rather than flashing that message under every run while it loads.
  const [steps, setSteps] = useState(null);

  const pruned = !!run.artifacts_deleted_at;

  // A pruned run's steps went with its artifacts — the notice below already
  // says so, so don't ask for a 404 to find that out.
  useEffect(() => {
    if (pruned) return;
    let current = true;
    api(`/api/runs/${run.id}/steps`, { token })
      .then((data) => current && setSteps(data.steps))
      .catch(() => current && setSteps([]));
    return () => {
      current = false;
    };
  }, [run.id, pruned, token]);

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

  return (
    <div className="run-detail">
      <div className="verdict-head">
        {run.test_name || 'Ad-hoc run'}
        <span className={`badge badge-${run.status}`}>{run.status}</span>
      </div>

      {showRecording && run.has_recording && (
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
      )}

      <div className="stats">
        <Stat
          label="Verdict"
          value={run.success === true ? 'Pass' : run.success === false ? 'Fail' : '—'}
          tone={run.success === true ? 'ok' : run.success === false ? 'bad' : ''}
        />
        <Stat label="Steps" value={run.steps_count ?? '—'} />
        <Stat label="Duration" value={formatDuration(run.started_at, run.finished_at)} />
      </div>

      <dl className="detail-facts">
        <dt>Started</dt>
        <dd>{formatWhen(run.created_at)}</dd>
        <dt>Trigger</dt>
        <dd>{run.trigger}</dd>
        <dt>URL</dt>
        <dd title={run.start_url}>{run.start_url}</dd>
      </dl>

      <p className="detail-goal">{run.goal}</p>

      {run.final_result && <p className="final">{run.final_result}</p>}
      {run.error && (
        <div className="error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{run.error}</span>
        </div>
      )}

      {/* Direct children of `.run-detail`, so the header and the list take the
          card's own gap — the same rhythm the live panel reads at. */}
      {!pruned && steps !== null && (
        <>
          <CardHead title="Activity" count={steps.length || undefined} />
          {steps.length > 0 ? (
            <ActivityLog steps={steps} />
          ) : (
            <EmptyState icon={Activity} title="No activity recorded">
              This run ended before its steps were written to disk.
            </EmptyState>
          )}
        </>
      )}

      {pruned ? (
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
            title={run.report_status === 'none' ? 'No report for this run' : undefined}
          >
            {reportBusy ? 'Preparing PDF…' : 'PDF report'}
          </Button>
          {run.has_recording && (
            <Button icon={showRecording ? Undo2 : Play} onClick={() => setShowRecording((v) => !v)}>
              {showRecording ? 'Hide recording' : 'Watch recording'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
