import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, MousePointerClick } from 'lucide-react';
import { api } from './api.js';
import RunDetail from './RunDetail.jsx';
import { Button, CardHead, EmptyState, PageHeader } from './ui.jsx';
import { statusColor, formatWhen, formatDuration } from './status.js';

// History (US-011): every run the control plane has kept, filtered and paged
// off GET /api/runs. The list rows carry everything the detail panel shows
// (the endpoint joins the test's name and grouping in), so selecting a run
// costs no request — only the PDF and the recording are fetched on demand.
const PAGE = 25;

const STATUS_FILTERS = [
  { value: 'all', label: 'Any status', query: '' },
  { value: 'passed', label: 'Passed', query: 'passed' },
  { value: 'failed', label: 'Failed or errored', query: 'failed,error' },
  { value: 'unfinished', label: 'Still running', query: 'queued,running' },
];

const RANGES = [
  { value: 'all', label: 'Any time', hours: null },
  { value: '24h', label: 'Last 24 hours', hours: 24 },
  { value: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { value: '30d', label: 'Last 30 days', hours: 24 * 30 },
];

export default function HistoryView({ token }) {
  const [projects, setProjects] = useState([]);
  const [tests, setTests] = useState([]);
  const [project, setProject] = useState('all');
  const [testId, setTestId] = useState('all');
  const [status, setStatus] = useState('all');
  const [range, setRange] = useState('all');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState({ runs: [], total: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filter options. Projects may not exist at all (grouping is optional), in
  // which case the project picker never renders — same progressive disclosure
  // the Run view follows.
  useEffect(() => {
    let cancelled = false;
    api('/api/projects', { token })
      .then((res) => !cancelled && setProjects(res.projects))
      .catch((err) => !cancelled && setError(`Projects: ${err.message}`));
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    const query = project === 'all' ? '' : `?project_id=${project}`;
    api(`/api/tests${query}`, { token })
      .then((res) => {
        if (cancelled) return;
        setTests(res.tests);
        // Narrowing the project must not leave a test filter it doesn't contain.
        setTestId((cur) => (cur === 'all' || res.tests.some((t) => t.id === cur) ? cur : 'all'));
      })
      .catch((err) => !cancelled && setError(`Tests: ${err.message}`));
    return () => {
      cancelled = true;
    };
  }, [token, project]);

  const query = useMemo(() => {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (project !== 'all') q.set('project_id', project);
    if (testId !== 'all') q.set('test_id', testId);
    const statuses = STATUS_FILTERS.find((f) => f.value === status)?.query;
    if (statuses) q.set('status', statuses);
    const hours = RANGES.find((r) => r.value === range)?.hours;
    if (hours) q.set('since', new Date(Date.now() - hours * 3600e3).toISOString());
    return q.toString();
  }, [project, testId, status, range, offset]);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/runs?${query}`, { token }));
      setError(null);
    } catch (err) {
      setError(`History: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [query, token]);

  useEffect(() => {
    load();
  }, [load]);

  // Changing a filter invalidates the page number, never the other way round.
  useEffect(() => {
    setOffset(0);
  }, [project, testId, status, range]);

  // A run started in the Run view finishes while this list is open, so poll —
  // but only while something is actually in flight.
  const hasActive = data.runs.some((r) => r.status === 'queued' || r.status === 'running');
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  const selected = data.runs.find((r) => r.id === selectedId) || null;
  const showing = data.runs.length ? `${offset + 1}–${offset + data.runs.length} of ${data.total}` : '';

  return (
    <>
      <PageHeader
        title="History"
        description="Every run the control plane has kept — verdict, report and recording."
      />

      {error && (
        <div className="error page-error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="history">
        <section className="card hist-list">
          <CardHead title="Runs">
            {showing && <span className="row-sub spacer">{showing}</span>}
          </CardHead>

          <div className="hist-filters">
            {projects.length > 0 && (
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="all">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
            <select value={testId} onChange={(e) => setTestId(e.target.value)}>
              <option value="all">All tests</option>
              {tests.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          {testId !== 'all' && <Timeline runs={data.runs} onPick={setSelectedId} selectedId={selectedId} />}

          {loading ? (
            <EmptyState icon={Clock}>Loading runs…</EmptyState>
          ) : data.runs.length === 0 ? (
            <EmptyState icon={Clock} title="No runs to show">
              {data.total === 0 && status === 'all' && range === 'all' && testId === 'all'
                ? 'Start a run and it is kept here — verdict, report and recording — instead of disappearing when the page closes.'
                : 'No runs match these filters.'}
            </EmptyState>
          ) : (
            <ul className="list">
              {data.runs.map((run) => (
                <li key={run.id} className={run.id === selectedId ? 'active' : ''}>
                  <span className="run-dot" style={{ background: statusColor(run.status) }} />
                  <button type="button" className="row-main" onClick={() => setSelectedId(run.id)}>
                    <span className="row-name">
                      {run.test_name || <em>Ad-hoc run</em>}
                      {run.trigger !== 'ui' && <span className="row-tag">{run.trigger}</span>}
                    </span>
                    <span className="row-sub">{run.goal}</span>
                  </button>
                  <span className="run-when">
                    {formatWhen(run.created_at)}
                    <span className="run-sub">
                      {run.steps_count ?? '—'} steps ·{' '}
                      {formatDuration(run.started_at, run.finished_at)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {data.total > PAGE && (
            <div className="hist-paging">
              <Button
                icon={ChevronLeft}
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
              >
                Newer
              </Button>
              <Button
                disabled={offset + PAGE >= data.total}
                onClick={() => setOffset((o) => o + PAGE)}
              >
                Older
                <ChevronRight size={15} strokeWidth={2} aria-hidden="true" />
              </Button>
            </div>
          )}
        </section>

        <section className="card hist-detail">
          {selected ? (
            <RunDetail run={selected} token={token} onError={setError} />
          ) : (
            <EmptyState icon={MousePointerClick} title="No run selected">
              Pick a run to see its verdict, report and recording.
            </EmptyState>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * Pass/fail strip for a single test, oldest on the left — the regression view.
 * It charts the runs currently listed rather than fetching its own window, so
 * what the strip shows and what the list shows can never disagree.
 */
function Timeline({ runs, onPick, selectedId }) {
  if (!runs.length) return null;
  const ordered = [...runs].reverse();
  const judged = ordered.filter((r) => r.success !== null);
  const passed = judged.filter((r) => r.success).length;

  return (
    <div className="timeline">
      <div className="timeline-head">
        <span>Oldest</span>
        <span className="timeline-rate">
          {judged.length
            ? `${passed}/${judged.length} passed in this page`
            : 'No verdicts in this page'}
        </span>
        <span>Newest</span>
      </div>
      <div className="timeline-bars">
        {ordered.map((run) => (
          <button
            key={run.id}
            type="button"
            className={`tl-bar${run.id === selectedId ? ' active' : ''}`}
            style={{ background: statusColor(run.status) }}
            title={`${formatWhen(run.created_at)} — ${run.status}`}
            onClick={() => onPick(run.id)}
          />
        ))}
      </div>
    </div>
  );
}
