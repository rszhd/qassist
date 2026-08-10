import { Brain, Play, Plus, Trash2 } from 'lucide-react';
import { Button, Field, IconButton, Modal } from './ui.jsx';
import RunMemory from './RunMemory.jsx';

/**
 * The one place a run is described. `run` mode fires an ad-hoc run and can
 * hand its values over to `create`; `create`/`edit` write a saved test. The
 * URL and goal are the caller's state either way, so whatever you typed here
 * is what the stage shows while the run happens.
 */
export function TestDialog({
  mode, goal, setGoal, startUrl, setStartUrl, editing, setEditing, variables, setVariables,
  projects, modules, sessions = [], hasDb, saving, token, onClose, onRun, onSave, onDelete,
  onSwitchToSave,
}) {
  const isRun = mode === 'run';
  const ready = startUrl.trim() && goal.trim() && (isRun || editing?.name.trim());
  const submit = (e) => {
    e.preventDefault();
    if (ready) (isRun ? onRun : onSave)();
  };

  return (
    <Modal
      title={isRun ? 'New run' : mode === 'edit' ? 'Edit test' : 'New test'}
      description={
        isRun
          ? 'Runs once, right now. Nothing is saved unless you ask for it.'
          : 'Saved tests re-run with one click and keep their history.'
      }
      onClose={onClose}
      footer={
        <>
          {mode === 'edit' && (
            <Button variant="danger" icon={Trash2} onClick={() => onDelete(editing)}>
              Delete
            </Button>
          )}
          {isRun && hasDb && (
            <Button variant="ghost" icon={Plus} onClick={onSwitchToSave} disabled={!ready}>
              Save as test
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={isRun ? Play : undefined}
            onClick={submit}
            disabled={!ready || saving}
          >
            {isRun ? 'Run test' : saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Save test'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="modal-form">
        {!isRun && (
          <Field label="Name">
            <input
              value={editing.name}
              autoFocus
              placeholder="Checkout flow works"
              onChange={(e) => setEditing((cur) => ({ ...cur, name: e.target.value }))}
            />
          </Field>
        )}

        {!isRun && projects.length > 0 && (
          <div className="field-row">
            <Field label="Project">
              <select
                value={editing.project_id || ''}
                onChange={(e) =>
                  // Changing project invalidates the module choice.
                  setEditing((cur) => ({ ...cur, project_id: e.target.value || null, module_id: null }))
                }
              >
                <option value="">Ungrouped</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            {modules.length > 0 && (
              <Field label="Module">
                <select
                  value={editing.module_id || ''}
                  onChange={(e) => setEditing((cur) => ({ ...cur, module_id: e.target.value || null }))}
                >
                  <option value="">No module</option>
                  {modules.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        )}

        {!isRun && sessions.length > 0 && (
          <Field
            label="Start signed in"
            hint="A saved session from this project. The run begins already logged in, so the login steps never happen."
          >
            <select
              value={editing.browser_session_id || ''}
              onChange={(e) =>
                setEditing((cur) => ({ ...cur, browser_session_id: e.target.value || null }))
              }
            >
              <option value="">No session — start from a cold browser</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label="Start URL"
          hint="Some sites (Reddit, Cloudflare-protected pages) block datacenter IPs and will fail from a server."
        >
          <input value={startUrl} autoFocus={isRun} onChange={(e) => setStartUrl(e.target.value)} />
        </Field>

        <Field
          label="Instructions"
          hint="A goal, a list of steps, or a pasted ticket. The agent follows it, and the verdict is judged against it."
        >
          <textarea rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>

        {!isRun && <VariablesEditor variables={variables} setVariables={setVariables} />}

        {/* Only when editing: a test that does not exist yet has nothing to
            remember, and the panel would read as a setting to decide before
            saving — which is the one thing US-081 is not.

            Deliberately NOT gated on `token`. It is empty in both of the modes
            most people run — a sign-in cookie carries the auth, and an open
            instance has none — so a gate on it would hide the panel from
            everyone but a token-configured deployment. `api()` omits the header
            when it is falsy, which is what every other view relies on. */}
        {mode === 'edit' && editing?.id && <RunMemory testId={editing.id} token={token} />}

        {/* Enter in a text field submits the dialog. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/**
 * Declare a saved test's variables (US-035). Kept out of the way for the basic
 * case: with none declared it is a single quiet "Add variable" button, so a
 * test that needs no variables looks exactly like the pre-US-035 dialog. Each
 * variable is a name and a default value; the goal/URL reference it as
 * `{{name}}` and a run can override it. An **optional** one may resolve empty.
 *
 * A **secret**'s value is stored encrypted and never read back (US-064), which
 * is what a schedule needs — it fires with nobody there to type one. So the box
 * is always empty on open and blank means *keep what is stored*, which in turn
 * is why the row has to say whether anything is stored and offer an explicit
 * clear. Without that pair, "leave it alone" and "erase it" are the same
 * gesture.
 */
function VariablesEditor({ variables, setVariables }) {
  const secretPlaceholder = (v) =>
    v.clear ? 'will be cleared on save' : v.value_set ? 'leave blank to keep' : 'value';
  const set = (i, changes) =>
    setVariables((cur) => cur.map((v, j) => (j === i ? { ...v, ...changes } : v)));
  const add = () => setVariables((cur) => [...cur, { name: '', value: '', secret: false, optional: false }]);
  const remove = (i) => setVariables((cur) => cur.filter((_, j) => j !== i));

  return (
    <div className="vars">
      {variables.length > 0 && (
        <>
          <span className="field-label">Variables</span>
          <p className="field-hint">
            Reference them in the goal or Start URL as <code>{'{{name}}'}</code>. Each run can
            override the default. A <b>secret</b> is stored encrypted and never shown again — leave
            it blank to keep the stored value; an <b>optional</b> one may resolve empty.
          </p>
          {variables.map((v, i) => (
            <div className="var-row" key={i}>
              <div className="var-main">
                <input
                  className="var-name"
                  value={v.name}
                  placeholder="name"
                  aria-label={`Variable ${i + 1} name`}
                  onChange={(e) => set(i, { name: e.target.value })}
                />
                <input
                  type={v.secret ? 'password' : 'text'}
                  value={v.value}
                  placeholder={v.secret ? secretPlaceholder(v) : 'default value'}
                  aria-label={`Variable ${i + 1} ${v.secret ? 'secret value' : 'default value'}`}
                  // Typing is the answer to "did you mean to clear this?" — no.
                  onChange={(e) => set(i, { value: e.target.value, clear: false })}
                />
                <IconButton icon={Trash2} variant="danger" label="Remove variable" onClick={() => remove(i)} />
              </div>
              <div className="var-flags">
                <label className="var-flag">
                  <input
                    type="checkbox"
                    checked={v.secret}
                    onChange={(e) => set(i, { secret: e.target.checked, clear: false })}
                  />
                  Secret
                </label>
                <label className="var-flag">
                  <input
                    type="checkbox"
                    checked={v.optional}
                    onChange={(e) => set(i, { optional: e.target.checked })}
                  />
                  Optional
                </label>
                {/* The box is empty whether or not a value is stored, and blank
                    means keep — so the row has to say which, and offer the only
                    gesture that means erase (US-064). */}
                {v.secret && (
                  <span className="var-state">
                    {v.clear ? 'will be cleared' : v.value_set ? 'stored' : 'not set'}
                    {(v.value_set || v.clear) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => set(i, { value: '', clear: !v.clear })}
                      >
                        {v.clear ? 'Keep' : 'Clear'}
                      </Button>
                    )}
                  </span>
                )}
              </div>
            </div>
          ))}
        </>
      )}
      <Button size="sm" variant="ghost" icon={Plus} onClick={add} className="var-add">
        Add variable
      </Button>
    </div>
  );
}

/**
 * Override a variable'd test's values for this one run (US-035), prefilled with
 * each default. Only opens for a test that declares variables — the one-click
 * run path is untouched for everything else.
 *
 * A secret's box is always empty, because its value is never read back — so for
 * one with a stored value (US-064) it has to say that leaving it alone is not
 * the same as running without one, or the operator retypes a password they did
 * not need to.
 */
export function RunVarsDialog({ test, values, setValues, onClose, onRun }) {
  const submit = (e) => {
    e.preventDefault();
    onRun();
  };
  return (
    <Modal
      title={`Run ${test.name}`}
      description="Set this run's variables, then run. Defaults are prefilled — a blank field runs empty."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Play} onClick={submit}>Run test</Button>
        </>
      }
    >
      <form onSubmit={submit} className="modal-form">
        {test.variables.map((v) => (
          <Field
            key={v.name}
            label={v.name}
            hint={
              v.secret
                ? v.value_set
                  ? 'Secret — leave blank to use the value stored on this test.'
                  : 'Secret — used for this run only, never stored.'
                : undefined
            }
          >
            <input
              type={v.secret ? 'password' : 'text'}
              value={values[v.name] ?? ''}
              onChange={(e) => setValues((cur) => ({ ...cur, [v.name]: e.target.value }))}
            />
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/**
 * What happens to a test's notebook when the test under it is edited (US-081).
 *
 * The edit has already landed; this decides one thing only. It is asked rather
 * than decided because the fingerprint knows *that* the instructions changed and
 * never whether that changed the flow — a typo fixed in the goal and the test
 * repointed at another app are the same event to it, and only the person who
 * just made the edit can tell them apart.
 *
 * All three answers end with the next run learning the flow again; they differ
 * in what happens to the old lessons. Keep re-keys them and they are supplied as
 * before. Start fresh deletes them now, because a button saying that should not
 * leave them sitting in the panel. Dismissing does neither — they stay, unused,
 * until the next passing run replaces them — which is what makes dismissing the
 * answer you can give by accident.
 */
export function MemoryPromptDialog({ lessons, saving, onKeep, onDiscard, onClose }) {
  const what = lessons === 1 ? 'lesson' : 'lessons';
  return (
    <Modal
      title="Keep what this test learned?"
      description={
        `You changed what this test does. Its Run memory holds ${lessons} ${what} ` +
        'that earlier runs worked out.'
      }
      onClose={onClose}
      footer={
        <>
          {/* Discards now, so the panel does not go on showing lessons the
              person has just said goodbye to. Deliberately NOT `onClose`: the X,
              Escape and the scrim all reach that one, and throwing away a
              notebook because somebody dismissed a dialog is the wrong kind of
              surprise. Dismissing leaves the automatic behaviour — withheld, and
              replaced by the next passing run. */}
          <Button onClick={onDiscard} disabled={saving}>Start fresh</Button>
          <Button variant="primary" icon={Brain} onClick={onKeep} disabled={saving}>
            Keep {what}
          </Button>
        </>
      }
    />
  );
}
