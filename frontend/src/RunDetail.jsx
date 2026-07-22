import { useState } from 'react';
import { AlertTriangle, Download, Play, Undo2 } from 'lucide-react';
import { openReport } from './api.js';
import { Button, Stat } from './ui.jsx';
import { formatWhen, formatDuration } from './status.js';

// One past run, rendered entirely from the row the history list already has.
// Only the two artifacts are fetched: the PDF as a blob (it needs the bearer
// header) and the recording as a plain <video src> with a query token, which
// is what makes seeking work (US-006).
//
// Step screenshots belong here too once US-020 lands.
export default function RunDetail({ run, token, onError }) {
  const [reportBusy, setReportBusy] = useState(false);
  const [showRecording, setShowRecording] = useState(false);

  const pruned = !!run.artifacts_deleted_at;

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
