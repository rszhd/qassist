import { Play, Plus, Trash2 } from 'lucide-react';
import { Button, Field, IconButton, Modal } from './ui.jsx';

/**
 * The one place a run is described. `run` mode fires an ad-hoc run and can
 * hand its values over to `create`; `create`/`edit` write a saved test. The
 * URL and goal are the caller's state either way, so whatever you typed here
 * is what the stage shows while the run happens.
 */
export function TestDialog({
  mode, goal, setGoal, startUrl, setStartUrl, editing, setEditing, variables, setVariables,
  projects, modules, sessions = [], hasDb, saving, onClose, onRun, onSave, onDelete, onSwitchToSave,
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

        <Field label="Start URL">
          <input value={startUrl} autoFocus={isRun} onChange={(e) => setStartUrl(e.target.value)} />
        </Field>

        <Field
          label="Goal"
          hint="Some sites (Reddit, Cloudflare-protected pages) block datacenter IPs and will fail from a server."
        >
          <textarea rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>

        {!isRun && <VariablesEditor variables={variables} setVariables={setVariables} />}

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
 * `{{name}}` and a run can override it. A **secret** carries no stored default
 * (its value arrives per run or from CI, never persisted); an **optional** one
 * may resolve empty.
 */
function VariablesEditor({ variables, setVariables }) {
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
            override the default. A <b>secret</b> is never stored or shown — its value is set per
            run or by CI; an <b>optional</b> one may resolve empty.
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
                {v.secret ? (
                  <span className="var-note">value set per run / CI</span>
                ) : (
                  <input
                    value={v.value}
                    placeholder="default value"
                    aria-label={`Variable ${i + 1} default value`}
                    onChange={(e) => set(i, { value: e.target.value })}
                  />
                )}
                <IconButton icon={Trash2} variant="danger" label="Remove variable" onClick={() => remove(i)} />
              </div>
              <div className="var-flags">
                <label className="var-flag">
                  <input
                    type="checkbox"
                    checked={v.secret}
                    // A secret carries no stored default — clear it on toggle so no
                    // plaintext secret lands in tests.variables (US-035 secret path).
                    onChange={(e) => set(i, e.target.checked ? { secret: true, value: '' } : { secret: false })}
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
            hint={v.secret ? 'Secret — never stored or shown after this run.' : undefined}
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
