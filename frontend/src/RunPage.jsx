import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, History, KeyRound, SearchX } from 'lucide-react';
import { api } from './api.js';
import RunDetail from './RunDetail.jsx';
import { Button, EmptyState, PageHeader } from './ui.jsx';
import { statusLabel } from './status.js';

// One run at its own address (US-030), which is what a notification email and
// a CI job can link to. It renders through the same RunDetail the History
// panel uses, so the two can't drift; the only thing this page adds is being
// reachable, and staying correct if the run is still going.
//
// A run in flight is followed over the WebSocket rather than polled: steps
// stream into the activity list, and the terminal event triggers one refetch
// so the verdict, the step count and the report link arrive together.
//
// The frames are shown for the same reason: subscribing is what turns the
// screencast on (US-002 only captures while a viewer is attached), so a page
// that attached and then dropped the frames would cost the run's Chromium the
// encode either way. This is the one bit of the Run view's stage repeated
// here — the rest of that stage is its own state (queued copy, replay player,
// verdict card) and belongs to it.
export default function RunPage({ token, needsToken, onOpenSettings }) {
  const { id } = useParams();
  const [run, setRun] = useState(null);
  const [steps, setSteps] = useState(null);
  // US-044's evidence, accumulated off the relay so a run in flight explains
  // itself as it goes rather than only once the report exists.
  const [evidence, setEvidence] = useState({ diagnostics: [], dropped: 0 });
  const [frame, setFrame] = useState(null);
  const [error, setError] = useState(null);
  const [missing, setMissing] = useState(false);
  const wsRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setRun(await api(`/api/runs/${id}`, { token }));
      setMissing(false);
    } catch (err) {
      if (err.status === 404) setMissing(true);
      else setError(err.message);
    }
  }, [id, token]);

  useEffect(() => {
    if (needsToken) return;
    load();
  }, [load, needsToken]);

  const unfinished = run?.status === 'queued' || run?.status === 'running';
  const liveUrl = [...(steps || [])].reverse().find((s) => s.url)?.url || run?.start_url;

  // Attach once, on the transition into a run we know is live — `load()` runs
  // again when that run ends, and reopening the socket on every refetch would
  // reconnect the moment it closed.
  useEffect(() => {
    if (!unfinished || wsRef.current) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/ws?runId=${id}&token=${encodeURIComponent(token)}`
    );
    // The relay replays the run's buffered events on connect, so the list is
    // built from scratch here rather than seeded from GET /:id/steps.
    setSteps([]);
    setEvidence({ diagnostics: [], dropped: 0 });
    ws.onmessage = (m) => {
      let evt;
      try {
        evt = JSON.parse(m.data);
      } catch {
        return;
      }
      if (evt.type === 'step' || evt.type === 'progress' || evt.type === 'blocked') {
        setSteps((s) => [...(s || []), evt]);
      }
      else if (evt.type === 'diagnostics') {
        // `dropped` is the agent's running total, so the newest event is the
        // whole answer — accumulating it would multiply it by the step count.
        setEvidence((e) => ({
          diagnostics: [...e.diagnostics, ...(evt.entries || [])],
          dropped: evt.dropped || e.dropped,
        }));
      }
      else if (evt.type === 'frame' && evt.data) setFrame(`data:image/jpeg;base64,${evt.data}`);
      else if (evt.type === 'status') setRun((r) => r && { ...r, status: evt.status });
      else if (evt.type === 'end' || evt.type === 'done' || evt.type === 'error') load();
    };
    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [unfinished, id, token, load]);

  return (
    <>
      {/* The short id, not the goal: RunDetail renders the goal below, and
          printing it here too opened the page with the same paragraph twice.
          The id is the thing this page has that the History panel doesn't, and
          it tells two runs of the same test apart. The status rides up here
          with the title for the same reason — it is the first thing the page
          is asked, so it shouldn't need a scroll. */}
      <PageHeader title={run?.test_name || 'Run'} description={`Run ${String(id).slice(0, 8)}`}>
        {run && <span className={`badge badge-${run.status}`}>{statusLabel(run.status)}</span>}
        <Button as={Link} icon={History} to="/history">All runs</Button>
      </PageHeader>

      {needsToken && (
        <div className="banner page-error">
          <KeyRound size={14} aria-hidden="true" />
          <span>
            <strong>API token needed</strong>
            <span>
              This worker requires a token before it will show a run. Until then the report
              attached to the notification is the whole story.
            </span>
          </span>
          <Button size="sm" className="spacer" onClick={() => onOpenSettings()}>Add token</Button>
        </div>
      )}

      {error && (
        <div className="error page-error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* Nothing below the banner without a token — an empty card under it
          would read as the run itself having come back empty.

          The run itself brings its own cards: RunDetail's page layout is two
          independent columns, so wrapping it in one more card here would draw a
          border around a pair of borders. Only the states that are a single
          message — no such run, still loading — get a card of their own. */}
      {!needsToken &&
        (missing ? (
          <section className="card">
            <EmptyState
              icon={SearchX}
              title="No such run"
              action={<Button as={Link} to="/history">Browse history</Button>}
            >
              This id belongs to no run this worker knows about — either the link is wrong, or
              the run was removed with the database it lived in.
            </EmptyState>
          </section>
        ) : run ? (
          <div className="run-page">
            {unfinished && frame && (
              <div className="browser">
                <div className="browser-bar">
                  <span className="browser-dots"><i /><i /><i /></span>
                  <span className="browser-url">{liveUrl}</span>
                </div>
                <div className="screen">
                  <img src={frame} alt="live browser view" />
                </div>
              </div>
            )}
            <RunDetail
              run={run}
              token={token}
              onError={setError}
              liveSteps={unfinished ? steps : null}
              liveDiagnostics={unfinished ? evidence : null}
              layout="page"
              onStopped={load}
            />
          </div>
        ) : (
          <section className="card">
            <EmptyState icon={History}>Loading run…</EmptyState>
          </section>
        ))}
    </>
  );
}
