# Steering a live run

Sometimes you watch the agent hunt for a button you can see. It is one click
away, in a menu it has not opened, and it is about to spend five more steps
looking. You do not have to throw the run away and start again with a longer
instruction. You can pause it, tell it what to do, and let it carry on from
where it is.

Two controls appear on a run while it is going, on the Run view and on the run's
own page:

- **Pause** holds the agent before its next action. The screencast keeps
  working, so you can look at the page properly.
- **The instruction box**, above the activity list, sends a sentence to the
  running agent.

## Telling a run what to do

Type what you would tell a colleague looking over their shoulder:

> the confirm button is in the account menu

> the price is in the second column, not the first

Then press **Send**. The agent receives it as a follow-up instruction and keeps
going from the step it was on. Everything it has already done is kept.

**Your instruction is added, it does not replace the goal.** The run is still
judged against what you originally asked for. A hint that says "just click
anything and finish" does not change what a pass means — it only changes what
the agent does next, and the verdict is still measured against the original
instruction.

**You do not have to pause first.** A hint sent to a run that is still moving
reaches it at its next action. Pausing is for when you want to read the screen
before deciding what to say. And if you type an instruction while a run is
held, sending it also resumes the run — you type once.

## What a pause costs

A paused run is still holding a browser and one of the instance's run slots, so
it cannot be held forever. If nobody resumes it, QAssist ends it for you, and
the notice on screen says when. The run then shows as **stopped**, keeping the
steps and the recording it did produce — the same ending as pressing Stop.

Self-hosting: that window is `PAUSE_MAX_SECONDS`, ten minutes by default. See
[Self-hosting](./self-hosting.md).

A resumed run keeps the time limit it had left, not a fresh one. A run cannot
be given more wall-clock time by pausing it repeatedly.

## What it costs the verdict

**A run somebody steered proves less than a run that finished alone.** A pass
that needed a person to point at the button did not show that a user could have
found it.

QAssist does not let that go unsaid. An assisted run says so in three places:

- your instruction appears in the run's activity, in the order it happened,
  marked as something you wrote;
- the PDF report carries a **This run was assisted** note on its cover, above
  the errors, with what you said and when;
- the note repeats what the verdict does and does not cover.

So a hint is the right tool for *finishing an investigation* — proving the rest
of the flow works once you are past the sticking point. It is the wrong tool for
a test you run every night. If a saved test needs the same hint every time, that
hint belongs in the instruction itself; see
[Writing instructions](./writing-instructions.md).

## When it will not work

Resuming is not guaranteed. While a run is held, the app you are testing carries
on with its own clock: a login session can expire, and a page can time you out.
The agent then fails on its next action, and the run reports that honestly
rather than pretending the pause was free. If you are testing behind a login,
see [Behind your login](./saved-sessions.md).

A queued run cannot be paused — it has no browser yet, and nothing has started
that could be held. Wait for it to get a slot.
