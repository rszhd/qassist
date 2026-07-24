import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, ArrowRight, Check, Download, Film, PanelLeftClose, PanelLeftOpen, Pencil, Play, X,
} from 'lucide-react';
import { api } from './api.js';
import ActivityLog from './Activity.jsx';
import { TestDialog } from './RunDialogs.jsx';
import { Button, CardHead, EmptyState, IconButton, PageHeader, Stat } from './ui.jsx';

const noop = () => {};

// US-033: the live demo. A visitor with no account picks a sample test, presses
// Run, and watches a *recorded* session replay over the very same stage a real
// run uses — a fixture's event log streamed over ws?demo=<slug> at its recorded
// offsets, with the recording playing beside it. No agent, no browser, no queue
// slot, no LLM call and no runs row: this is a canned replay, and it says so.
//
// Everywhere it appears it is labelled a recorded session and offers no control
// implying a live agent — no Edit, no Re-run; the replay ends on a signup CTA.
export default function DemoView({ health }) {
  // null while loading; the endpoint 404s when DEMO_MODE is off, which App
  // already guards against by only routing here when health.demo is set.
  const [demos, setDemos] = useState(null);
  const [meta, setMeta] = useState({ speed: 1, ctaUrl: null });
  const [loadError, setLoadError] = useState(null);

  // The demo being played, or null for the picker. Everything below is this
  // replay's live state, mirroring RunView's handlers minus the run-only bits
  // (no frames — the visual is the recording — no queue, no report, no re-run).
  const [active, setActive] = useState(null);
  const [status, setStatus] = useState('idle');
  const [steps, setSteps] = useState([]);
  const [result, setResult] = useState(null);
  const [currentAction, setCurrentAction] = useState(null);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState(null);
  // The demo whose test form is open as a read-only preview, or null.
  const [preview, setPreview] = useState(null);
  // The rail collapses to a strip, like the Run view's. Its own key, so the two
  // rails remember their state independently.
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('qassist_demo_rail') !== 'min');
  const wsRef = useRef(null);
  const logRef = useRef(null);

  useEffect(() => {
    localStorage.setItem('qassist_demo_rail', railOpen ? 'open' : 'min');
  }, [railOpen]);

  useEffect(() => {
    api('/api/demo')
      .then(({ demos: rows, speed, ctaUrl }) => {
        setDemos(rows);
        setMeta({ speed, ctaUrl });
      })
      .catch((err) => setLoadError(err.message));
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [steps]);

  // Drop the replay socket when the view unmounts — navigating away should stop
  // the stream, not leave timers firing into a closed tab.
  useEffect(() => () => wsRef.current?.close(), []);

  const multi = health?.auth_mode === 'multi';
  const condensed = meta.speed && meta.speed !== 1;

  function handleEvent(evt) {
    switch (evt.type) {
      case 'status':
        setStatus(evt.status);
        if (evt.status === 'running') setCurrentAction('Loading the page…');
        break;
      case 'step':
        setCurrentAction(evt.next_goal || evt.thinking || evt.evaluation || 'Thinking…');
        setSteps((s) => [...s, evt]);
        break;
      case 'progress':
        setCurrentAction(evt.message);
        setSteps((s) => [...s, evt]);
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
        setEnded(true);
        setStatus((cur) => (cur === 'running' ? evt.status : cur));
        break;
      default:
        break;
    }
  }

  function play(demo) {
    if (wsRef.current) wsRef.current.close();
    setActive(demo);
    setSteps([]);
    setResult(null);
    setError(null);
    setEnded(false);
    setCurrentAction(null);
    setStatus('running');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // No token, by design — the demo is the one unauthenticated socket.
    const ws = new WebSocket(`${proto}://${location.host}/ws?demo=${encodeURIComponent(demo.slug)}`);
    ws.onerror = () => setError('The demo stream could not connect.');
    ws.onmessage = (m) => {
      try {
        handleEvent(JSON.parse(m.data));
      } catch {
        /* ignore malformed */
      }
    };
    wsRef.current = ws;
  }

  const liveUrl = [...steps].reverse().find((s) => s.url)?.url || '';
  const running = status === 'running';
  const passed = result?.success === true;
  const failed = result?.success === false;
  const browserUrl = active ? liveUrl || 'Recorded session' : 'Ready when you are';

  // The demo mirrors the Run view's shape: a rail of choices on the left, the
  // live stage on the right. The rail lists demos instead of saved tests, and
  // the stage plays a recording instead of a live screencast — but the layout
  // is the same one, so a visitor sees the product's real console.
  return (
    <>
      <PageHeader
        title="Live demo"
        description="Watch a real QAssist session play out — a previously recorded run, replayed step by step. No account, no setup."
      >
        <span className="badge demo-badge">Demo</span>
      </PageHeader>

      {(error || loadError) && (
        <div className="error page-error">
          <X size={14} aria-hidden="true" />
          <span>{error || `Couldn't load the demos: ${loadError}`}</span>
        </div>
      )}

      <div className={`run-grid${railOpen ? '' : ' rail-min'}`}>
        {!railOpen && (
          <button type="button" className="rail-strip" title="Show demos" onClick={() => setRailOpen(true)}>
            <PanelLeftOpen size={14} aria-hidden="true" />
            <span>Demos</span>
          </button>
        )}

        {railOpen && (
        <aside className="card rail">
          <CardHead title="Demos" count={demos?.length || undefined}>
            <IconButton
              icon={PanelLeftClose}
              label="Minimize demos"
              onClick={() => setRailOpen(false)}
              className="spacer"
            />
          </CardHead>
          {demos && demos.length > 0 ? (
            <ul className="list">
              {demos.map((d) => (
                <li key={d.slug} className={`demo-row${active?.slug === d.slug ? ' active' : ''}`}>
                  <div className="demo-row-head">
                    <span className="row-name">{d.name}</span>
                    {d.verdict && (
                      <span className={`badge badge-${d.verdict === 'pass' ? 'passed' : 'failed'}`}>
                        {d.verdict === 'pass' ? 'Pass' : 'Fail'}
                      </span>
                    )}
                    {/* Edit opens a read-only preview of the form, so a visitor
                        sees how a test is written without an account. */}
                    <IconButton icon={Pencil} label="See the test form" onClick={() => setPreview(d)} />
                    <IconButton
                      icon={Play}
                      variant="accent"
                      label={`Run "${d.name}"`}
                      onClick={() => play(d)}
                      disabled={running}
                    />
                  </div>
                  <p className="demo-desc">{d.description}</p>
                </li>
              ))}
            </ul>
          ) : demos ? (
            <EmptyState icon={Film} title="No demos available">
              This instance has <code>DEMO_MODE</code> on but no fixtures under <code>demo/</code>.
            </EmptyState>
          ) : (
            !loadError && <EmptyState icon={Film} title="Loading demos…" />
          )}
        </aside>
        )}

        <section className="stage">
          <div className="stage-split">
            <div className="stage-main">
              <div className="browser">
                <div className="browser-bar">
                  <span className="browser-dots"><i /><i /><i /></span>
                  <span className="browser-url">{browserUrl}</span>
                  <span className="badge demo-badge">Demo</span>
                </div>
                <div className={`screen${active?.hasRecording ? '' : ' screen-empty'}`}>
                  {active?.hasRecording ? (
                    // Plain <video src> off the fixture endpoint (Range honoured,
                    // no token). Muted so it can autoplay; controls off so the
                    // replay reads as a live session, not a video the user scrubs.
                    <video
                      key={active.slug}
                      src={`/api/demo/${active.slug}/recording`}
                      autoPlay
                      muted
                      playsInline
                      onError={() => setError('The recording could not be loaded.')}
                    />
                  ) : active ? (
                    <div className="thinking">
                      <div className="spinner" />
                      <div>Replaying the recorded session…</div>
                    </div>
                  ) : (
                    <EmptyState icon={Film} title="Pick a demo to watch">
                      Choose a sample test on the left and its recorded session replays here.
                    </EmptyState>
                  )}
                </div>
              </div>

              {active && (
                <p className="replay-note">
                  This is a recorded session replayed from a saved event log — no browser, no agent
                  and no cost per view.{condensed ? ` Playing at ${meta.speed}× the recorded speed.` : ''}
                </p>
              )}

              {currentAction && (
                <div className="action-bar">
                  <span className="pulse" /> {currentAction}
                </div>
              )}

              {result && (
                <div className={`card verdict ${passed ? 'ok' : failed ? 'bad' : ''}`}>
                  <div className="verdict-head">
                    {passed ? <Check size={15} /> : failed ? <X size={15} /> : null}
                    {passed ? 'Passed' : failed ? 'Failed' : 'Done'}
                  </div>
                  <div className="stats">
                    <Stat
                      label="Verdict"
                      value={passed ? 'Pass' : failed ? 'Fail' : '—'}
                      tone={passed ? 'ok' : failed ? 'bad' : ''}
                    />
                    <Stat label="Steps" value={result.steps ?? '—'} />
                    <Stat
                      label="Duration"
                      value={result.duration_seconds ? `${Math.round(result.duration_seconds)}s` : '—'}
                    />
                  </div>
                  {result.final_result && <p className="final">{result.final_result}</p>}
                  {active.hasReport && (
                    <div className="verdict-actions">
                      {/* The fixture's PDF, served inline with no auth — a plain
                          link, not the bearer-fetched blob a real run needs. */}
                      <Button
                        as="a"
                        href={`/api/demo/${active.slug}/report.pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        icon={Download}
                      >
                        PDF report
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {ended && (
                <div className="card demo-cta">
                  <h3>That was a recorded demo. Try it on your own site.</h3>
                  <p>
                    QAssist drives a real browser against any URL from a goal you write in plain
                    English — then judges pass or fail and hands you a report.
                  </p>
                  {multi ? (
                    <Button as={Link} to="/" variant="primary" icon={ArrowRight}>
                      Sign up free
                    </Button>
                  ) : (
                    <Button
                      as="a"
                      href={meta.ctaUrl || 'https://qassist.run'}
                      variant="primary"
                      icon={ArrowRight}
                    >
                      Get QAssist
                    </Button>
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
                  {running
                    ? 'The first step lands shortly.'
                    : active
                      ? 'Steps appear here during the replay.'
                      : 'Pick a demo to see its steps here.'}
                </EmptyState>
              )}
            </aside>
          </div>
        </section>
      </div>

      {preview && (
        <TestDialog
          readOnly
          mode="edit"
          goal={preview.goal}
          setGoal={noop}
          startUrl={preview.start_url}
          setStartUrl={noop}
          editing={{ name: preview.name }}
          setEditing={noop}
          variables={[]}
          setVariables={noop}
          projects={[]}
          modules={[]}
          hasDb={false}
          saving={false}
          onClose={() => setPreview(null)}
          onRun={noop}
          onSave={noop}
          onDelete={noop}
          onSwitchToSave={noop}
        />
      )}
    </>
  );
}
