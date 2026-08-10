import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Brain, Check, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { api } from './api.js';
import { formatWhen } from './status.js';
import { Button, IconButton, Modal } from './ui.jsx';

// What a saved test remembers between runs (US-081), in the edit dialog.
//
// Secondary on purpose, and collapsed until asked for. The feature is automatic
// — it learns, invalidates and relearns with nobody acting — so a panel that
// announced itself would turn a thing you can ignore into another field to fill
// in. Shut, it is a heading and nothing else; open it and it says what the next
// run gets before it shows the lessons.
//
// The three sections are the generator's own and the headings are ours: a
// section this UI has no name for is still shown, because dropping it would
// silently hide advice the agent is being given.
const HEADINGS = {
  successful_approach: 'What worked',
  avoid_next_time: 'Avoid next time',
  orientation: 'Orientation',
};

// Why the next run is not getting what is stored, in the words a person would
// use. One reason, because one thing stops a notebook applying: the test changed
// under it. A run that did not pass leaves it alone.
const WITHHELD = {
  inputs_changed: 'Set aside after an edit — the next run goes cold and relearns',
};

/** One line for what the next run gets. */
function summarize(memory) {
  if (!memory) return 'Loading…';
  if (memory.withheld) return WITHHELD[memory.withheld] || 'Held back — the next run goes cold';
  if (memory.supplied) return 'The next run starts with what earlier runs learned';
  return 'Nothing learned yet — the next run starts cold';
}

/** A lesson reads as one sentence whichever section it is in. */
function lessonText(item) {
  return item.text || item.attempt || '';
}

export default function RunMemory({ testId, token }) {
  const [open, setOpen] = useState(false);
  const [memory, setMemory] = useState(null);
  const [busy, setBusy] = useState(false);
  // Clear throws away everything the test has learned, so it asks first — in the
  // app's own dialog, because a native confirm cannot say what is at stake and
  // does not look like the rest of the product.
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setMemory(await api(`/api/tests/${testId}/memory`, { token }));
    } catch (err) {
      setError(`Run memory: ${err.message}`);
    }
  }, [testId, token]);

  // Loaded whether or not the panel is open: whether there is anything to
  // disclose is itself an answer, and the collapsed panel has to know it.
  useEffect(() => {
    load();
  }, [load]);

  async function mutate(label, fn) {
    setBusy(true);
    setError(null);
    try {
      setMemory(await fn());
    } catch (err) {
      setError(`${label}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  // A lesson is removed by its id and cannot be edited in place: "learned" means
  // a run trace produced it, so a wrong one is dropped and a later run learns
  // the flow again from a fresh trace.
  function removeLesson(id) {
    mutate('Remove', () =>
      api(`/api/tests/${testId}/memory/lessons/${id}`, { token, method: 'DELETE' })
    );
  }

  // The same answer the save-time prompt asks for, offered where a person would
  // look for it afterwards. Without it, dismissing that prompt — Escape, or a
  // stray click on the scrim — strands the notebook for good: it is set aside,
  // the panel says so, and the only route back is to edit the instructions again
  // so the prompt fires a second time.
  function keepAnyway() {
    mutate('Keep', () => api(`/api/tests/${testId}/memory/keep`, { token, method: 'POST' }));
  }

  function clearAll() {
    setConfirming(false);
    mutate('Clear', async () => {
      await api(`/api/tests/${testId}/memory`, { token, method: 'DELETE' });
      return api(`/api/tests/${testId}/memory`, { token });
    });
  }

  const learned = memory?.learned || {};
  const sections = Object.entries(learned).filter(([, items]) => items?.length);

  const failed = error && (
    <div className="error">
      <AlertTriangle size={14} aria-hidden="true" />
      <span>{error}</span>
    </div>
  );

  // Nothing learned is the state every new test sits in, so the panel is not
  // there at all rather than a heading over nothing. That is the story's rule
  // about this feature made visible: it is automatic and safe to ignore, and a
  // permanent empty drawer in the edit dialog is a thing you have to open once
  // to find out it never mattered.
  //
  // A failed READ is different and still shows: silently hiding it would make a
  // broken endpoint look exactly like a test that has learned nothing.
  if (!sections.length) return failed ? <div className="memory-panel">{failed}</div> : null;

  return (
    <div className="memory-panel">
      <button
        type="button"
        className="group-toggle memory-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <Brain size={14} aria-hidden="true" />
        <span className="group-name">Run memory</span>
      </button>

      {open && (
        <div className="memory-body">
          {failed}

          {/* What the next run gets. */}
          <p className="field-hint">{summarize(memory)}</p>

          {sections.map(([name, items]) => (
            <div key={name} className="memory-section">
              <h4>{HEADINGS[name] || name}</h4>
              <ul className="list">
                {items.map((item) => (
                  <li key={item.id}>
                    <span className="row-main">
                      <span className="row-name">{lessonText(item)}</span>
                      {/* A mistake is three sentences and needs all three: what
                          was tried, why it was wrong, and what to do instead.
                          Dropping the alternative leaves a dead end. */}
                      {item.reason && (
                        <span className="row-sub">
                          {item.reason}
                          {item.instead ? ` Instead: ${item.instead}` : ''}
                        </span>
                      )}
                      {/* Per item, because a notebook holds lessons from several
                          runs at once. A hint is credited to the person: it is
                          evidence from outside, not something the agent found. */}
                      {item.run_id && (
                        <span className="row-sub">
                          {item.hinted ? 'From a run you guided' : 'Learned'}{' '}
                          {formatWhen(item.learned_at)} —{' '}
                          <Link to={`/runs/${item.run_id}`}>the run that found it</Link>
                        </span>
                      )}
                    </span>
                    <span className="row-actions">
                      <IconButton
                        icon={Trash2}
                        label="Remove this lesson"
                        onClick={() => removeLesson(item.id)}
                        disabled={busy}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="memory-foot">
            {memory?.withheld === 'inputs_changed' && (
              <Button icon={Check} onClick={keepAnyway} disabled={busy}>
                These still apply
              </Button>
            )}
            <Button variant="ghost" icon={Trash2} onClick={() => setConfirming(true)} disabled={busy}>
              Clear
            </Button>
          </div>

          {confirming && (
            <Modal
              title="Clear what this test has learned?"
              description="The next run starts as if this test had never run before."
              onClose={() => setConfirming(false)}
              footer={
                <>
                  <Button onClick={() => setConfirming(false)}>Cancel</Button>
                  <Button variant="danger" icon={Trash2} onClick={clearAll}>
                    Clear memory
                  </Button>
                </>
              }
            >
              <p className="field-hint">
                Run history is not affected — the runs that produced these lessons
                stay exactly as they are. A later passing run will learn the flow
                again from its own trace.
              </p>
            </Modal>
          )}
        </div>
      )}
    </div>
  );
}
