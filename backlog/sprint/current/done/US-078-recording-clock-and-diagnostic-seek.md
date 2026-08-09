# US-078 — The recording's clock, said out loud, and a diagnostic that jumps to it

**As a** user, **I want** the run page to tell me why the recording is shorter
than the run, and a diagnostic to take me to the moment it happened, **so that**
I stop reading a condensed replay as a truncated one, and the finding that
explains a failure is one click from seeing it.

- **Status:** ✅ Done 2026-08-09, 6/6
- **Priority:** P2 — small, and it closes the one call US-076 left open. Neither
  half blocks anything.
- **Estimate:** ~half a day. Tier 1 is a sentence in two places; tier 2 is a
  join between two lists the same component already holds.
- **Depends on:** US-076 (`video_seconds` and the seek), US-044 (the
  diagnostics), US-006 (the recording)

## Context

US-076 shipped the mapping from a step to its place in `recording.mp4` and
recorded, in its own "One open call", that a step row shows `elapsed` while the
player's control bar shows video time, and that the two disagree by however long
the run sat waiting. The call was to show `elapsed` and accept the disagreement.
It is the right call and nothing says it to the user.

So the run page currently states three numbers that cannot be reconciled from
the page itself: **Duration** in the rail is wall clock, the step times under
each row are wall clock, and the scrub bar the reader is dragging is not. A run
that waited on a slow login is 3:41 in the rail and 0:48 in the player. The two
readings a user reaches unaided — the recording was cut short, or the step times
are wrong — are both wrong, and both are reasonable. `runEvents.js` already
carries the explanation as a typedef comment for us; the user gets nothing.

The second half is the same page's other gap. Diagnostics sit above the Activity
list and are grouped under the step they happened during — and on a failed run
that block is the answer, where the step list is only the context. The step rows
below it seek the recording. The block above it does not, so the reader who
found the `500` has to go back down to the step list, find the row with the same
number, and click that instead.

## Details

### Tier 1 — say what the recording's clock is (`RunDetail.jsx`, `manual/`)

- A `.hint` under the player in the `recording` block, rendered with it, so it
  is absent exactly when the player is. Draft wording, to be tightened when it
  is seen at width:

  > Only frames the page repainted are recorded, so the recording is shorter
  > than the run and its clock is not the step times below.

- **Words, not a second number.** The video's own length is already on the
  player's control bar, and printing it beside the run's duration invites the
  subtraction ("where did the other 2:53 go?") that the sentence exists to head
  off. Nothing new is fetched or measured — no `onLoadedMetadata`, no
  `videoRef.current.duration`.
- The manual owns the longer version: [`reading-a-verdict.md`](../../../../manual/reading-a-verdict.md)
  → "The recording" gains a paragraph on the condensed clock, so the page can
  stay one line. `manual/` is user material and `docs/` links it rather than
  copying it (`CLAUDE.md`), and this is user material.
- **A step row does not gain a second time.** Two unlabelled times in a 300px
  rail is a worse question than one time and a sentence, and labelling them
  costs the row the width the goal needs. The row keeps `elapsed`.

### Tier 2 — a diagnostic group seeks the recording (`Diagnostics.jsx`, `RunDetail.jsx`)

**The group heading is the target, not the row.** A finding is deduplicated
with a `count`, so an entry that reads `12×` stands for twelve moments and owns
none of them. The step it is attributed to is the only well-defined time a
finding has, and it is the time already on screen next to it.

- No protocol change and no new field. `RunDetail` holds `steps` and
  `diagnostics` in the same component, and a step already carries
  `video_seconds` — so build the step-number → `video_seconds` map there and
  pass it to `Diagnostics` with the existing `seekRecording` handler. The scroll
  into view, the play, and the "no player means no handler" rule all come along
  unchanged.
- **"Before the first step" seeks 0.** That group is the page's own load, which
  is the head of the recording by definition; it needs no map entry.
- A heading is a `<button>` only when the handler **and** a map hit are both
  there, a `<div>` otherwise — the same rule as a step row, and it covers the
  same cases for free: no recording, a run in flight, a pruned run, a run
  recorded before US-076, and the History panel, which has no player at all. One
  more case is new: a live run whose finding arrives before the step event it
  belongs to has no map entry yet, and reads as text until it does.
- Styling goes beside `.diag-step` in `views.css`. It is a small heading that
  became clickable, not a row — it should not grow to look like one.

**Rejected: a `video_seconds` per finding.** Capturing the frame counter inside
`DiagnosticCollector` would cost the callable into a module kept deliberately
browser-free, plus a per-entry field through `step_events.py`, `runEvents.js`
and `runState.js` — to produce a number that is wrong for any entry with a
`count` above 1. If a per-finding time is ever wanted, the honest form is
first-seen and last-seen, and that is a different story.

**Not assertion-first.** The arithmetic that earned that treatment shipped in
US-076 and holds its row in [`correctness-critical.md`](../../../correctness-critical.md)
("Recording seek offset"). What is left here is a lookup and a rendering
decision, which fail visibly. No new row is owed.

### Deferred

A diagnostic that is linkable — `/runs/<id>?t=12.5` — would let the PDF's
diagnostics point at the moment rather than at the page, and would make a step
row copyable as a link too. It needs the seek to become URL state, which is a
larger change than either tier here and is worth its own story if it is wanted.

## Acceptance criteria

- [x] The run page says, where the player is, why the recording is shorter than
      the run's duration — and says nothing when there is no recording
- [x] The manual explains the condensed clock under "The recording"
- [x] A step row still shows one time, and it is `elapsed`
- [x] Clicking a diagnostics group heading seeks the recording to that step's
      first recorded frame
- [x] "Before the first step" seeks to the start of the recording
- [x] A run with no recording, one still in flight, one recorded before US-076,
      and the History panel all show the headings as text

## Results

Shipped as planned — the design above survived contact, so what follows is the
few things that were decided while building rather than a second telling.

**Tier 1.** The `.hint` needed a wrapper. `.detail-main > * + *` draws a rule and
a gap between siblings, so a sentence emitted beside the player would have read
as the section *after* the recording rather than as its caption. `.detail-recording`
is that wrapper — a flex column with one gap — and it inherits the recording's
place as the column's first child, so it still opens the card without a rule.

**Tier 2.** The map is built where both lists already are, first event wins:
a step number can carry more than one event and the earliest is the frame the
step starts at. A step with no `video_seconds` gets no entry rather than a
wall-clock fallback, which is US-076's rule repeated — the recording is
condensed, so seeking to `elapsed` lands somewhere plausible and wrong.

The one thing the CSS had to say: clearing a `<button>`'s UA border clears all
four sides, and `.diag-step`'s bottom rule with it, so `button.diag-step`
restates that border. Hover changes the colour rather than the background,
because the heading is `position: sticky` over the rows it scrolls past and a
translucent `--hover` on it would let them show through.

The manual paragraph went slightly wider than "the condensed clock": it also
names the click, because a reader who has just been told the two clocks disagree
wants to know what to do about it, and the answer is on the same page.

**Verified:** `frontend` 13 files / 121 tests pass, `vite build` clean,
`manual` build clean, `check-doc-links.mjs` clean. Not looked at in a browser —
the CSS is two rules and a wrapper.
