import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button, CardHead } from './ui.jsx';

// The instructions a run was given, clamped to what its column can hold with a
// toggle when there is more. Shared by the run's own page and the Run view's
// card, so the one field with no length limit reads the same way wherever it is
// shown. How many lines the clamp keeps is CSS (`.detail-goal`) — that is what
// lets the page hold twelve of them and a rail four.
//
// `resetKey` is what the paragraph is about: a run id, a test id. A different
// subject is a different goal, and without this the next one opens already
// unfolded because the last one was.
export default function GoalBlock({ goal, resetKey }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef(null);

  // Whether the goal actually outgrows its clamp, so one that already fits
  // doesn't get a toggle that does nothing. Only measurable while collapsed —
  // expanded, scrollHeight and clientHeight are equal by definition, so the
  // last collapsed answer is the one worth keeping. The observer is what
  // catches a width change: these columns narrow at the breakpoints, and a goal
  // that needed four lines at 440px may need six at 320px.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, goal]);

  useEffect(() => setOpen(false), [resetKey]);

  return (
    <section className="goal-block">
      <CardHead title="Instructions" />
      <p ref={ref} className={`detail-goal${open ? ' open' : ''}`}>{goal}</p>
      {clamped && (
        <Button
          variant="ghost"
          size="sm"
          icon={open ? ChevronUp : ChevronDown}
          aria-expanded={open}
          onClick={() => setOpen((isOpen) => !isOpen)}
        >
          {open ? 'Show less' : 'Read more'}
        </Button>
      )}
    </section>
  );
}
