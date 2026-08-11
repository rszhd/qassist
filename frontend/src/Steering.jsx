import { useState } from 'react';
import { Pause, Play, Send } from 'lucide-react';
import { Button } from './ui.jsx';

// The two controls US-079 adds to a live run, shared by the Run view and the
// live RunDetail so the same run offers the same levers wherever it is being
// watched. They are separate exports because they belong in different places on
// the page: the button sits with Stop above the activity, the box sits under
// the activity it is about to change.

/**
 * Hold the run before its next action, or let it go again. Neutral, not
 * `danger`: a pause interrupts nothing and costs nothing — Stop stays the only
 * red on a healthy run, which is what makes it findable.
 */
export function PauseButton({ paused, onPause, onResume }) {
  return paused ? (
    <Button icon={Play} onClick={onResume}>Resume</Button>
  ) : (
    <Button icon={Pause} onClick={onPause}>Pause</Button>
  );
}

/**
 * Say what the agent should do next. Additive on the agent's side: the original
 * goal survives and the run carries on from the step it was on, which is the
 * whole reason this exists instead of "stop and re-run with a longer prompt".
 *
 * Cleared on submit rather than on the server's answer: what was typed is gone
 * from the box the moment it is sent, so a second Enter cannot send it twice.
 */
export function HintBox({ paused, until, onHint, onResume }) {
  const [text, setText] = useState('');

  function submit(e) {
    e.preventDefault();
    const said = text.trim();
    if (!said) return;
    setText('');
    onHint(said);
  }

  return (
    <form className="steer" onSubmit={submit}>
      {paused && (
        <p className="hint steer-held">
          Held before the next action. {until ? <Deadline until={until} /> : null} Type an
          instruction to carry on, or press Resume.
        </p>
      )}
      <div className="steer-row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Tell the run what to do"
          placeholder="Tell it what to do…"
          maxLength={MAX_HINT_CHARS}
        />
        <Button type="submit" icon={Send} disabled={!text.trim()}>Send</Button>
      </div>
      {/* A hint sent to a held run also releases it, so the user types once —
          said here because the button says Resume and the field does not. */}
      {paused && onResume && <p className="hint">Sending also resumes the run.</p>}
    </form>
  );
}

// Mirrors MAX_HINT_CHARS in server/src/routes/runs.js. Enforced there; this only
// stops the box accepting what the server would refuse.
const MAX_HINT_CHARS = 1000;

/**
 * When the pause budget ends the run if nobody resumes it.
 *
 * A clock time and not a countdown, deliberately: nothing arrives on the socket
 * while a run is held, so a rendered duration would sit at "10 min" for ten
 * minutes unless a ticker were added to keep it honest. A deadline is true
 * without being re-rendered.
 */
function Deadline({ until }) {
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) return null;
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return <>It is ended at {clock} if nothing happens.</>;
}
