import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, MousePointerClick } from 'lucide-react';
import { api } from './api.js';
import RunDetail from './RunDetail.jsx';
import Timeline, { runMarks } from './Timeline.jsx';
import { Button, CardHead, EmptyState, PageHeader } from './ui.jsx';
import { statusLabel, formatWhen, formatDuration, formatCost, formatTokens } from './status.js';

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
  // US-047. Its own option rather than folded into "Failed or errored": what
  // you come here to ask is which runs nobody let finish, and the answer is
  // otherwise only reachable by reading every row under "Any status".
  { value: 'cancelled', label: 'Stopped', query: 'cancelled' },
];

// 'ui,api' is one option rather than two: what you want to separate is "a
// person was watching" from "something ran this on its own", and which button
// the person pressed is not that distinction.
const TRIGGER_FILTERS = [
  { value: 'all', label: 'Any trigger', query: '' },
  { value: 'schedule', label: 'Scheduled', query: 'schedule' },
  { value: 'manual', label: 'Started by hand', query: 'ui,api' },
  { value: 'ci', label: 'From CI', query: 'ci' },
];

const RANGES = [
  { value: 'all', label: 'Any time', hours: null },
  { value: '24h', label: 'Last 24 hours', hours: 24 },
  { value: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { value: '30d', label: 'Last 30 days', hours: 24 * 30 },
];

export default function HistoryView({ token, reports }) {
  // Arrived at from a bar on the Schedules strip (US-069). Read off the URL
  // rather than copied into state, so the filter is linkable and survives a
  // reload — the same call Projects makes about which project is open.
  const [searchParams, setSearchParams] = useSearchParams();
  const scheduleId = searchParams.get('schedule_id') || '';

  const [projects, setProjects] = useState([]);
  const [tests, setTests] = useState([]);
  const [project, setProject] = useState('all');
  const [testId, setTestId] = useState('all');
  const [status, setStatus] = useState('all');
  const [trigger, setTrigger] = useState('all');
  const [range, setRange] = useState('all');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState({ runs: [], total: 0, usage: null });
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
    if (scheduleId) q.set('schedule_id', scheduleId);
    const statuses = STATUS_FILTERS.find((f) => f.value === status)?.query;
    if (statuses) q.set('status', statuses);
    const triggers = TRIGGER_FILTERS.find((f) => f.value === trigger)?.query;
    if (triggers) q.set('trigger', triggers);
    const hours = RANGES.find((r) => r.value === range)?.hours;
    if (hours) q.set('since', new Date(Date.now() - hours * 3600e3).toISOString());
    return q.toString();
  }, [project, testId, scheduleId, status, trigger, range, offset]);

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
  }, [project, testId, scheduleId, status, trigger, range]);

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

  // US-046 tier 2, and the surface the story warns about: this is a sum, so
  // every way it can be wrong is a plausible number rather than a broken one.
  //
  // The server answers for the whole filter set, never the page — so this line
  // does not move when you press Older, which is the only reading of it that
  // means anything.
  //
  // Two rules it keeps. It never sums a set it could only partly price without
  // saying so: `priced_runs` against `total` is the disclosure, and it is not
  // rendered quieter than the figure it qualifies. And it falls back to tokens
  // rather than to nothing — an instance with `CALCULATE_COST=0`, or one that
  // never reached the pricing table, still has a real measurement to show.
  const usage = data.usage;
  const priced = usage?.priced_runs > 0;
  const partial = priced && usage.priced_runs < data.total;
  const total = usage && (usage.total_tokens != null || priced) && (
    <div className="hist-total">
      {priced && (
        <>
          Est. cost <b>{formatCost(usage.total_cost, true, usage.total_tokens)}</b>
          {usage.total_tokens != null && ' · '}
        </>
      )}
      {usage.total_tokens != null && <>{formatTokens(usage.total_tokens)} tokens</>}
      {partial && (
        <span className="partial">
          {' '}— {usage.priced_runs} of {data.total} runs priced
        </span>
      )}
      {!priced && (
        <span className="partial">
          {' '}— no run in this set could be priced
        </span>
      )}
    </div>
  );

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
            <select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              {TRIGGER_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          {total}

          {/* A schedule filter has no picker to show it — it arrives in the
              URL from a bar on the Schedules strip. Without this the list is
              silently narrowed and the only way out is the back button, which
              is not obviously the way out. */}
          {scheduleId && (
            <div className="hist-scope">
              <span>Runs from one schedule</span>
              <Button
                size="sm"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('schedule_id');
                  setSearchParams(next, { replace: true });
                }}
              >
                Show all
              </Button>
            </div>
          )}

          {testId !== 'all' && (
            <Timeline
              marks={runMarks(data.runs)}
              endLabel="Newest"
              onPick={setSelectedId}
              selectedKey={selectedId}
            />
          )}

          {loading ? (
            <EmptyState icon={Clock}>Loading runs…</EmptyState>
          ) : data.runs.length === 0 ? (
            <EmptyState icon={Clock} title="No runs to show">
              {data.total === 0 &&
              status === 'all' &&
              trigger === 'all' &&
              range === 'all' &&
              testId === 'all'
                ? 'Start a run and it is kept here — verdict, report and recording — instead of disappearing when the page closes.'
                : 'No runs match these filters.'}
            </EmptyState>
          ) : (
            <ul className="list">
              {data.runs.map((run) => (
                <li key={run.id} className={run.id === selectedId ? 'active' : ''}>
                  <span className={`badge badge-${run.status}`}>{statusLabel(run.status)}</span>
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

        {/* `is-empty` so the phone layout can drop the panel entirely: stacked
            it sits above the list, and a placeholder there is a screen of
            nothing between you and the runs you came to read. */}
        <section className={`card hist-detail${selected ? '' : ' is-empty'}`}>
          {selected ? (
            // Keyed by run: picking another run starts its panel clean rather
            // than painting the previous run's steps under the new verdict.
            <RunDetail
              key={selected.id}
              run={selected}
              token={token}
              onError={setError}
              onStopped={load}
              permalink
              reports={reports}
            />
          ) : (
            <EmptyState icon={MousePointerClick} title="No run selected">
              Pick a run to see its verdict. What the agent did, the report and the recording
              are on the run's own page.
            </EmptyState>
          )}
        </section>
      </div>
    </>
  );
}

