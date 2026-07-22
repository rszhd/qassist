import { useState } from 'react';
import { openReport } from './api.js';
import { statusColor, formatWhen, formatDuration } from './status.js';

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
  const verdict = run.success === true ? 'ok' : run.success === false ? 'bad' : '';

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
      <h2>
        {run.test_name || 'Ad-hoc run'}
        <span className="badge" style={{ background: statusColor(run.status) }}>{run.status}</span>
      </h2>

      {showRecording && run.has_recording && (
        <div className="screen detail-screen">
          <video
            key={run.id}
            src={`/api/runs/${run.id}/recording${token ? `?token=${encodeURIComponent(token)}` : ''}`}
            controls
            autoPlay
            onError={() => onError('Recording could not be loaded.')}
          />
        </div>
      )}

      <dl className="detail-facts">
        <dt>Started</dt>
        <dd>{formatWhen(run.created_at)}</dd>
        <dt>Duration</dt>
        <dd>{formatDuration(run.started_at, run.finished_at)}</dd>
        <dt>Steps</dt>
        <dd>{run.steps_count ?? '—'}</dd>
        <dt>Trigger</dt>
        <dd>{run.trigger}</dd>
        <dt>URL</dt>
        <dd className="detail-url">{run.start_url}</dd>
      </dl>

      <p className="detail-goal">{run.goal}</p>

      {run.final_result && <div className={`result ${verdict}`}><p className="final">{run.final_result}</p></div>}
      {run.error && <div className="error">⚠ {run.error}</div>}

      {pruned ? (
        <p className="hint">
          Artifacts were removed on {formatWhen(run.artifacts_deleted_at)} — the report and
          recording are gone, the verdict above is kept.
        </p>
      ) : (
        <div className="btn-row result-actions">
          <button
            type="button"
            className="report-btn"
            onClick={downloadReport}
            disabled={reportBusy || run.report_status === 'none'}
            title={run.report_status === 'none' ? 'No report for this run' : undefined}
          >
            {reportBusy ? 'Preparing PDF…' : '⭳ PDF report'}
          </button>
          {run.has_recording && (
            <button type="button" className="report-btn" onClick={() => setShowRecording((v) => !v)}>
              {showRecording ? '⤺ Hide recording' : '▶ Watch recording'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
