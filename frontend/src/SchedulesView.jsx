import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarClock, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { api } from './api.js';
import Timeline, { slotMarks, slotCaption } from './Timeline.jsx';
import { Button, CardHead, EmptyState, Field, IconButton, Modal, PageHeader } from './ui.jsx';
import { formatWhen } from './status.js';

// Schedules (US-010 UI): one flat list of everything that fires unattended,
// ordered by when it fires next. A schedule can point at a test, a module, a
// suite or a project, so per-row controls on each of those would scatter the
// same editor across three views and still leave "what runs tonight?"
// unanswerable without visiting all of them (decision 9).
//
// GET /api/schedules resolves the target's type and name, so a row needs no
// other request to name what it fires.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Divisors of 24 only, so the slots repeat identically every day (decision 1). */
const HOURLY_INTERVALS = [1, 2, 3, 4, 6, 8, 12];

/** The four things a schedule can point at, and where the editor lists them. */
const TARGET_TYPES = [
  { column: 'test_id', type: 'test', label: 'Test', key: 'tests', url: '/api/tests' },
  { column: 'module_id', type: 'module', label: 'Module', key: 'modules', url: '/api/modules' },
  { column: 'suite_id', type: 'suite', label: 'Suite', key: 'suites', url: '/api/suites' },
  { column: 'project_id', type: 'project', label: 'Project', key: 'projects', url: '/api/projects' },
];

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Every zone the browser knows, so "02:00 in Berlin" doesn't depend on where
// the server happens to sit. Older engines have no supportedValuesOf; there the
// picker collapses to this browser's own zone, which is the useful default.
const ZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [localZone];
  }
})();

const pad = (n) => String(n ?? 0).padStart(2, '0');

/** The preset in words — the row's subtitle, and the editor's live preview. */
function describeSchedule(s) {
  const zone = s.tz && s.tz !== localZone ? ` · ${s.tz}` : '';
  if (s.kind === 'hourly') {
    const every =
      s.interval_hours === 1 ? 'Every hour' : `Every ${s.interval_hours} hours`;
    return `${every} at :${pad(s.minute)}${zone}`;
  }
  const time = `${pad(s.hour)}:${pad(s.minute)}`;
  if (s.kind === 'weekly') return `${WEEKDAYS[s.weekday ?? 0]}s at ${time}${zone}`;
  return `Daily at ${time}${zone}`;
}

/** How long until the next slot — the number you actually scan the list for. */
function formatUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'due now';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  return `in ${Math.round(hours / 24)}d`;
}

/** A blank form; `column`/`target_id` are what the create call names its target with. */
const blankForm = () => ({
  id: null,
  column: 'test_id',
  target_id: '',
  kind: '',
  interval_hours: 6,
  hour: 9,
  minute: 0,
  weekday: 1,
  tz: localZone,
});

/** An existing row as form state. The target is fixed, so it rides along as a label. */
const formFor = (s) => ({
  id: s.id,
  target_name: s.target_name,
  target_type: s.target_type,
  kind: s.kind,
  interval_hours: s.interval_hours ?? 6,
  hour: s.hour ?? 9,
  minute: s.minute ?? 0,
  weekday: s.weekday ?? 1,
  tz: s.tz || localZone,
});

export default function SchedulesView({ token }) {
  const navigate = useNavigate();
  const [schedules, setSchedules] = useState([]);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // A refusal the editor caused belongs to the editor: rendered on the page it
  // sits behind the overlay, where the person who just pressed Create can't
  // read it (the server refuses a schedule whose test has an unstored secret).
  const [formError, setFormError] = useState(null);

  const openEditor = (form) => {
    setFormError(null);
    setEditing(form);
  };

  const load = useCallback(async () => {
    try {
      const { schedules: rows } = await api('/api/schedules', { token });
      setSchedules(rows);
      setError(null);
    } catch (err) {
      setError(`Schedules: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  // The scheduler ticks every 60 s; matching it keeps "in 4h" and the last-run
  // time from going stale while the view sits open.
  useEffect(() => {
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [load]);

  async function mutate(label, fn, report = setError) {
    setBusy(true);
    report(null);
    try {
      await fn();
      setEditing(null);
      await load();
    } catch (err) {
      report(`${label}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  // The preset's fields are sent per kind rather than wholesale: an hourly
  // schedule carrying `hour: 9` would read as if it fired at 09:00, and the
  // server would only zero it again.
  function save(form) {
    const body = { kind: form.kind, minute: Number(form.minute), tz: form.tz || null };
    if (form.kind === 'hourly') body.interval_hours = Number(form.interval_hours);
    else body.hour = Number(form.hour);
    if (form.kind === 'weekly') body.weekday = Number(form.weekday);

    if (form.id) {
      mutate(
        'Save schedule',
        () => api(`/api/schedules/${form.id}`, { token, method: 'PUT', body }),
        setFormError
      );
    } else {
      mutate(
        'Create schedule',
        () =>
          api('/api/schedules', {
            token,
            method: 'POST',
            body: { ...body, [form.column]: form.target_id },
          }),
        setFormError
      );
    }
  }

  const toggle = (s) =>
    mutate(s.enabled ? 'Pause schedule' : 'Resume schedule', () =>
      api(`/api/schedules/${s.id}`, { token, method: 'PUT', body: { enabled: !s.enabled } })
    );

  function remove(s) {
    if (!window.confirm(`Delete this schedule for "${s.target_name}"?\n\nThe ${s.target_type} itself is not deleted.`)) return;
    mutate('Delete schedule', () => api(`/api/schedules/${s.id}`, { token, method: 'DELETE' }));
  }

  // The server orders by next_run_at, which a paused schedule still carries
  // from before it was paused — so it would sort among the ones that will
  // actually fire. Paused rows go last instead, keeping the top of the list
  // an honest answer to "what happens next?".
  const ordered = useMemo(() => {
    const at = (s) => (s.next_run_at ? new Date(s.next_run_at).getTime() : Infinity);
    return [...schedules].sort((a, b) => a.enabled === b.enabled ? at(a) - at(b) : a.enabled ? -1 : 1);
  }, [schedules]);

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Tests, modules, suites and projects that run on their own — soonest first."
      >
        <Button variant="primary" icon={Plus} onClick={() => openEditor(blankForm())}>
          New schedule
        </Button>
      </PageHeader>

      {error && (
        <div className="error page-error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* `sched-list` so the phone layout can reach these rows: they are the one
          list in the app carrying a name, a next-run time and three actions at
          once, which is more than a phone row holds side by side. */}
      <section className="card sched-list">
        <CardHead title="Schedules" count={schedules.length} />

        {loading ? (
          <EmptyState icon={CalendarClock}>Loading schedules…</EmptyState>
        ) : ordered.length === 0 ? (
          <EmptyState icon={CalendarClock} title="Nothing is scheduled">
            A schedule runs a saved test, module, suite or project on its own — nightly, hourly or
            weekly — so breakage turns up without anyone pressing Run.
          </EmptyState>
        ) : (
          <ul className="list">
            {ordered.map((s) => (
              <li key={s.id} className={s.enabled ? '' : 'paused'}>
                <span className="row-main">
                  <span className="row-name">
                    {s.target_name}
                    <span className="row-tag">{s.target_type}</span>
                    {s.target_tests === 0 && <span className="row-tag warn">no tests</span>}
                    {/* US-069: the strip below charts slots that produced runs,
                        so a schedule consuming slot after slot and starting
                        nothing draws as blank — which reads as quiet, not as
                        broken. The tag is the only thing that says otherwise.
                        Not shown beside "no tests", which already names the
                        reason this one is guessing at. */}
                    {s.firing_into_nothing && s.target_tests !== 0 && (
                      <span className="row-tag warn">not running</span>
                    )}
                  </span>
                  <span className="row-sub">
                    {describeSchedule(s)}
                    {s.target_tests === 0 && ' · nothing to run'}
                  </span>
                </span>
                <span className="run-when">
                  {s.enabled ? formatWhen(s.next_run_at) : 'Paused'}
                  <span className="run-sub">
                    {s.enabled && s.next_run_at ? formatUntil(s.next_run_at) : ''}
                    {s.last_run_at && ` · last ${formatWhen(s.last_run_at)}`}
                  </span>
                </span>
                <span className="row-actions">
                  <IconButton
                    icon={s.enabled ? Pause : Play}
                    label={s.enabled ? 'Pause this schedule' : 'Resume this schedule'}
                    disabled={busy}
                    onClick={() => toggle(s)}
                  />
                  <IconButton
                    icon={Pencil}
                    label="Edit when this runs"
                    onClick={() => openEditor(formFor(s))}
                  />
                  <IconButton
                    icon={Trash2}
                    variant="danger"
                    label="Delete"
                    disabled={busy}
                    onClick={() => remove(s)}
                  />
                </span>
                {/* US-069. Its own line under the row rather than a fourth
                    column: the row already carries more than a phone fits side
                    by side, and a strip squeezed beside three touch targets is
                    unreadable at every width. A schedule with nothing
                    attributed draws no strip at all — Timeline returns null on
                    an empty list — so a row that has never fired looks exactly
                    as it did before this shipped. */}
                <span className="sched-strip">
                  <Timeline
                    marks={slotMarks(s.recent || [])}
                    caption={slotCaption(s.recent || [])}
                    onPick={() => navigate(`/history?schedule_id=${s.id}`)}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <ScheduleEditor
          form={editing}
          setForm={setEditing}
          token={token}
          busy={busy}
          error={formError}
          onSubmit={save}
          onClose={() => setEditing(null)}
          onError={setFormError}
        />
      )}
    </>
  );
}

/**
 * The preset editor. Kind starts at `Off` and each kind's fields appear only
 * once it is chosen (decision 7), so the dialog asks for a weekday only when
 * there is a weekday to ask about. `Off` is not a state a schedule can be
 * saved in — pausing one is the row's Pause button, deleting it the bin.
 *
 * The target is chosen only on create: an existing schedule keeps the thing it
 * was created for, so that `last_run_at` keeps meaning what it says.
 */
function ScheduleEditor({ form, setForm, token, busy, error, onSubmit, onClose, onError }) {
  const [targets, setTargets] = useState(null);
  const set = (patch) => setForm((cur) => ({ ...cur, ...patch }));

  useEffect(() => {
    if (form.id) return undefined;
    let cancelled = false;
    Promise.all(TARGET_TYPES.map((t) => api(t.url, { token })))
      .then((results) => {
        if (cancelled) return;
        const loaded = Object.fromEntries(TARGET_TYPES.map((t, i) => [t.column, results[i][t.key]]));
        setTargets(loaded);
        // Tests are the default target type, but a fresh install may have only
        // a project. Land on the first type that has anything in it.
        if (!loaded[form.column]?.length) {
          const first = TARGET_TYPES.find((t) => loaded[t.column]?.length);
          if (first) setForm((cur) => ({ ...cur, column: first.column, target_id: '' }));
        }
      })
      .catch((err) => !cancelled && onError(`Targets: ${err.message}`));
    return () => {
      cancelled = true;
    };
    // Deliberately not keyed on form.column: the lists seed the form once, and
    // re-running on a form change would fight the user's own choice of type.
  }, [form.id, token, onError]);

  // Only the types that exist are offered — with no projects yet there are no
  // modules or suites either, and a picker whose every option is empty is a
  // question the user can't answer (US-023's progressive disclosure).
  const types = TARGET_TYPES.filter((t) => targets?.[t.column]?.length);
  const chosen = types.find((t) => t.column === form.column) || types[0];
  const options = chosen ? targets[chosen.column] : [];

  const time = `${pad(form.hour)}:${pad(form.minute)}`;
  const setTime = (value) => {
    const [hour, minute] = value.split(':');
    set({ hour: Number(hour) || 0, minute: Number(minute) || 0 });
  };

  const ready = form.kind && (form.id || form.target_id);

  return (
    <Modal
      title={form.id ? 'Edit schedule' : 'New schedule'}
      description="Scheduled runs use the same queue as manual ones, so a burst waits its turn rather than overloading the worker."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready || busy} onClick={() => onSubmit(form)}>
            {form.id ? 'Save schedule' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onSubmit(form);
        }}
      >
        {form.id ? (
          <div className="field">
            <span className="field-label">Runs</span>
            <span className="row-name">
              {form.target_name}
              <span className="row-tag">{form.target_type}</span>
            </span>
            <span className="field-hint">
              A schedule keeps the target it was made for. To run something else, make a new one.
            </span>
          </div>
        ) : (
          <div className="field-row">
            {types.length > 1 && (
              <Field label="Run a">
                <select
                  value={chosen?.column || ''}
                  onChange={(e) => set({ column: e.target.value, target_id: '' })}
                >
                  {types.map((t) => (
                    <option key={t.column} value={t.column}>{t.label}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={chosen?.label || 'Test'}>
              <select value={form.target_id} onChange={(e) => set({ target_id: e.target.value })}>
                <option value="">
                  {targets ? `Pick a ${chosen?.label.toLowerCase() || 'target'}…` : 'Loading…'}
                </option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <Field label="Repeat">
          <select value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="">Off — pick how often</option>
            <option value="hourly">Every few hours</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </Field>

        {form.kind === 'hourly' && (
          <div className="field-row">
            <Field label="Every" hint="Slots are anchored to midnight, so every 6 hours means 00, 06, 12, 18.">
              <select
                value={form.interval_hours}
                onChange={(e) => set({ interval_hours: Number(e.target.value) })}
              >
                {HOURLY_INTERVALS.map((n) => (
                  <option key={n} value={n}>{n === 1 ? '1 hour' : `${n} hours`}</option>
                ))}
              </select>
            </Field>
            <Field label="At minute">
              <input
                type="number"
                min="0"
                max="59"
                value={form.minute}
                onChange={(e) => set({ minute: e.target.value })}
              />
            </Field>
          </div>
        )}

        {(form.kind === 'daily' || form.kind === 'weekly') && (
          <div className="field-row">
            {form.kind === 'weekly' && (
              <Field label="On">
                <select value={form.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((day, i) => (
                    <option key={day} value={i}>{day}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="At">
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          </div>
        )}

        {form.kind && (
          <Field label="Timezone" hint="Times are wall-clock here, so 02:00 stays 02:00 across a daylight-saving change.">
            <select value={form.tz} onChange={(e) => set({ tz: e.target.value })}>
              {ZONES.map((zone) => (
                <option key={zone} value={zone}>{zone}</option>
              ))}
            </select>
          </Field>
        )}

        {form.kind && <p className="hint">{describeSchedule({ ...form, minute: Number(form.minute) })}</p>}

        {error && (
          <div className="error" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {/* Enter in a field submits the dialog. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
